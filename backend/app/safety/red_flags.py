"""Deterministic red-flag matcher -- IMPLEMENTATION.md section 9.1: "the most
important component in the system." Compiled phrase matching only, no model, no
network call, so it can never be taken down by an LLM outage (SAFETY-1: "An LLM
outage, rate limit, or hallucination must never suppress an emergency").

Runs on a 3-turn rolling window (patients describe symptoms across several
sentences, not always in the one that would match alone) with scoped negation:
a negation cue within 4 tokens before a match, not crossing a clause boundary,
suppresses it -- "no chest pain" and "the chest pain stopped yesterday" must not
fire (section 9.1's own examples).

Optimise for recall. A false positive costs one unnecessary emergency prompt; a
miss costs a delayed emergency. These are not symmetric.
"""

import re
import time
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import structlog
import yaml

logger = structlog.get_logger(__name__)

_YAML_PATH = Path(__file__).resolve().parent / "red_flags.yaml"

NEGATION_CUES = {
    "no", "not", "denies", "denied", "without", "never", "none", "negative", "absent", "ruled",
    "dont", "doesnt", "isnt", "wasnt", "arent", "didnt", "havent", "hasnt", "wouldnt",
}
# "stopped" only means negation *after* the symptom phrase ("chest pain stopped
# yesterday") -- checked by _is_negated_after, never by the backward-looking
# _is_negated, which would otherwise treat unrelated preceding uses of "stopped"
# ("I stopped and then felt chest pain") as negating a genuine symptom.
POSTFIX_NEGATION_CUES = {"stopped", "resolved", "gone", "cleared", "over", "fine"}
CLAUSE_BREAK_TOKENS = {"but", "and", "however", "although", "though", "except"}
NEGATION_WINDOW = 4
TURN_BOUNDARY = "<TURN>"
CLAUSE_BOUNDARY = "<BOUNDARY>"

_BOUNDARY_PUNCT_RE = re.compile(r"[.,;!?]")
_OTHER_PUNCT_RE = re.compile(r"[^\w\s.,;!?]")


# Three-tier triage (see match()). A bare red-flag phrase is ambiguous on its own:
# "crushing chest pain radiating to my arm" and "chest pain once a day for months"
# both contain "chest pain", but only the first is an emergency. Treating both as
# critical produces alarm fatigue, which is itself a patient-safety problem -- a
# banner that cries wolf is a banner people learn to dismiss.
TIER_CRITICAL = "critical"  # escalate immediately, on the first utterance
TIER_URGENT = "urgent"  # concerning: clarify first, re-evaluate every turn
TIER_ROUTINE = "routine"  # no red flag matched at all (never returned by match())

# Acuity markers -- presence forces TIER_CRITICAL regardless of chronic wording,
# because "I've had chest pain for months, but right now it's crushing" is an
# emergency that happens to mention a chronic history.
ACUTE_MARKERS = (
    "sudden", "suddenly", "severe", "severely", "crushing", "worst", "unbearable",
    "intense", "radiating", "spreading", "right now", "just started", "started just",
    "cant breathe", "cannot breathe", "cant speak", "struggling to breathe",
    "getting worse", "worse and worse", "sweating", "clammy", "passed out",
    "fainted", "collapsed", "blue", "unresponsive", "not responding",
)

# Chronic / low-acuity qualifiers -- these downgrade to TIER_URGENT *only* when no
# acute marker and no category amplifier is present.
CHRONIC_MARKERS = (
    "once a day", "twice a day", "every day", "everyday", "daily", "for months",
    "for years", "for weeks", "since months", "since years", "past few months",
    "past few weeks", "on and off", "off and on", "comes and goes", "now and then",
    "every now and then", "occasionally", "sometimes", "mild", "mildly", "slight",
    "slightly", "manageable", "not severe", "chronic", "long time", "long-standing",
)


@dataclass(frozen=True)
class RedFlagHit:
    id: str
    severity: str
    category: str
    matched_text: str
    script_id: str
    amplifiers_present: tuple[str, ...] = ()
    tier: str = TIER_CRITICAL
    tier_reason: str = ""


@dataclass(frozen=True)
class _Definition:
    id: str
    severity: str
    category: str
    script_id: str
    phrases: tuple[tuple[str, ...], ...]  # each phrase pre-tokenized
    amplifiers: tuple[str, ...]


def normalize(text: str) -> str:
    """Lowercase, drop apostrophes (can't -> cant, matching red_flags.yaml's
    phrasing), strip other punctuation, keep sentence punctuation as an explicit
    boundary token so negation scoping can detect clause breaks after
    normalization runs -- stripping it outright would destroy that signal."""
    text = text.lower().replace("'", "")
    text = _OTHER_PUNCT_RE.sub(" ", text)
    text = _BOUNDARY_PUNCT_RE.sub(f" {CLAUSE_BOUNDARY} ", text)
    return re.sub(r"\s+", " ", text).strip()


def _load_definitions(path: Path = _YAML_PATH) -> list[_Definition]:
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    definitions = []
    for entry in raw:
        phrases = tuple(tuple(normalize(p).split()) for p in entry["any_of"])
        definitions.append(
            _Definition(
                id=entry["id"],
                severity=entry["severity"],
                category=entry["category"],
                script_id=entry["script_id"],
                phrases=phrases,
                amplifiers=tuple(entry.get("amplifiers", [])),
            )
        )
    return definitions


@lru_cache
def _definitions() -> list[_Definition]:
    return _load_definitions()


def _find_spans(tokens: list[str], phrase: tuple[str, ...]) -> list[tuple[int, int]]:
    n, m = len(tokens), len(phrase)
    if m == 0 or m > n:
        return []
    spans = []
    for i in range(n - m + 1):
        if tuple(tokens[i : i + m]) == phrase:
            spans.append((i, i + m))
    return spans


def _is_negated(tokens: list[str], phrase_start: int) -> bool:
    """Prefix negation: "no chest pain", "denies chest pain"."""
    start = max(0, phrase_start - NEGATION_WINDOW)
    preceding = tokens[start:phrase_start]
    for tok in reversed(preceding):
        if tok in (CLAUSE_BOUNDARY, TURN_BOUNDARY) or tok in CLAUSE_BREAK_TOKENS:
            return False  # hit a clause/turn break before finding a negation cue
        if tok in NEGATION_CUES:
            return True
    return False


def _is_negated_after(tokens: list[str], phrase_end: int) -> bool:
    """Postfix negation: "the chest pain stopped yesterday", "chest pain resolved"."""
    following = tokens[phrase_end : phrase_end + NEGATION_WINDOW]
    for tok in following:
        if tok in (CLAUSE_BOUNDARY, TURN_BOUNDARY) or tok in CLAUSE_BREAK_TOKENS:
            return False  # hit a clause/turn break before finding a resolution cue
        if tok in POSTFIX_NEGATION_CUES:
            return True
    return False


def match(recent_utterances: list[str]) -> RedFlagHit | None:
    """`recent_utterances`: the rolling window (up to 3 turns), oldest first, raw
    patient speech -- normalization happens here. Returns the first (highest-
    priority-in-file-order) unnegated hit, or None. Deliberately synchronous and
    allocation-light: this runs on every finalized STT segment, concurrently with
    the LLM call, and section 9.1 requires it stay under 5ms."""
    joined = f" {TURN_BOUNDARY} ".join(normalize(u) for u in recent_utterances if u)
    tokens = joined.split()

    for definition in _definitions():
        for phrase in definition.phrases:
            for start, end in _find_spans(tokens, phrase):
                if _is_negated(tokens, start) or _is_negated_after(tokens, end):
                    continue
                matched_text = " ".join(phrase)
                amplifiers_present = tuple(a for a in definition.amplifiers if a in joined)
                tier, reason = _classify_tier(joined, amplifiers_present)
                return RedFlagHit(
                    id=definition.id,
                    severity=definition.severity,
                    category=definition.category,
                    matched_text=matched_text,
                    script_id=definition.script_id,
                    amplifiers_present=amplifiers_present,
                    tier=tier,
                    tier_reason=reason,
                )
    return None


def _classify_tier(joined: str, amplifiers_present: tuple[str, ...]) -> tuple[str, str]:
    """Decide CRITICAL vs URGENT for a phrase that already matched.

    Deliberately asymmetric, and that asymmetry is the safety property: an acute
    marker or a category amplifier always wins, and an unqualified red flag stays
    CRITICAL. Only an explicitly chronic/mild presentation with no acuity signal
    anywhere is downgraded -- so the failure mode remains a false alarm, never a
    missed emergency (section 9.1: "optimise for recall").
    """
    acute = [m for m in ACUTE_MARKERS if m in joined]
    if acute:
        return TIER_CRITICAL, f"acute marker(s): {', '.join(acute[:3])}"
    if amplifiers_present:
        return TIER_CRITICAL, f"amplifier(s): {', '.join(amplifiers_present[:3])}"
    chronic = [m for m in CHRONIC_MARKERS if m in joined]
    if chronic:
        return TIER_URGENT, f"chronic/mild qualifier(s): {', '.join(chronic[:3])}"
    return TIER_CRITICAL, "red flag with no de-escalating context"


def match_timed(recent_utterances: list[str]) -> tuple[RedFlagHit | None, float]:
    """Same as match(), also returning elapsed ms -- for logging/alerting if the
    5ms budget (section 9.1) is ever exceeded in practice."""
    start = time.perf_counter()
    hit = match(recent_utterances)
    elapsed_ms = (time.perf_counter() - start) * 1000
    if elapsed_ms > 5.0:
        logger.warning("red_flag_match_over_budget", elapsed_ms=elapsed_ms)
    return hit, elapsed_ms
