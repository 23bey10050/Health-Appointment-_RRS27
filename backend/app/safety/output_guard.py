"""Output guard -- IMPLEMENTATION.md section 9.3 / SAFETY-2. Runs on every LLM
response before it reaches TTS, patient-facing path only. The system prompt
(llm/prompts/voice_agent_system.v1.md) already tells the model not to diagnose or
prescribe; this is the enforcement layer that doesn't trust the model to comply.

Optimise for recall here too, same as the red-flag matcher: a false positive
costs one substituted line ("I'm not able to advise on that..."), a miss lets
diagnostic or prescriptive language reach a patient. Not symmetric.
"""

import re

import structlog

logger = structlog.get_logger(__name__)

SAFE_FALLBACK_LINE = "I'm not able to advise on that -- your doctor will go through it with you at the visit."

# SAFETY-2: block the agent *asserting* a diagnosis, not asking about symptoms.
# Over-blocking is not the safe option -- it replaces a good question with a
# dead-end refusal and derails the booking.
#
# Two patterns needed a certainty adverb added, because without one they fired on
# ordinary speech: "you are experiencing" matched "What symptoms are you
# experiencing?", and "(this|that) is" matched "that is booked".
DIAGNOSTIC_PATTERNS: list[re.Pattern] = [
    re.compile(r"\byou\s+have\b", re.I),
    re.compile(r"\byou(?:'re| are)\s+suffering from\b", re.I),
    re.compile(
        r"\byou(?:'re| are)\s+(?:probably|likely|possibly|definitely|clearly)\s+(?:having|experiencing)\b", re.I
    ),
    re.compile(r"\b(?:this|that|it)(?:'s| is)\s+(?:likely|probably|possibly|definitely)\b", re.I),
    re.compile(r"\b(?:this|that|it)\s+(?:looks|sounds)\s+like\b", re.I),
    re.compile(r"\byou\s+(?:might|may|could)\s+have\b", re.I),
    re.compile(r"\bmy diagnosis\b", re.I),
    re.compile(r"\byou(?:'re| are)\s+diagnosed with\b", re.I),
    re.compile(r"\bthe (?:condition|diagnosis) is\b", re.I),
]

PRESCRIPTIVE_PATTERNS: list[re.Pattern] = [
    re.compile(r"\btake\s+(?:\w+\s+)?(?:tablets?|pills?|capsules?|doses?|mg|milligrams?|ml\b)", re.I),
    re.compile(r"\b\d+\s*(?:mg|milligrams?|ml|milliliters?)\b", re.I),
    re.compile(r"\bi\s+(?:recommend|suggest|prescribe)\s+(?:taking|you take)\b", re.I),
    re.compile(r"\byou should take\b", re.I),
    re.compile(r"\byou (?:can|could) take\b", re.I),
]

ALL_PATTERNS = [("diagnostic", p) for p in DIAGNOSTIC_PATTERNS] + [("prescriptive", p) for p in PRESCRIPTIVE_PATTERNS]

_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+")
_QUESTION_OPENER = re.compile(
    r"^\s*(?:do|does|did|have|has|had|are|is|was|were|can|could|would|will|shall|should|may|any|"
    r"what|when|where|why|how|which|who|whose|and|or|but)?\s*"
    r"(?:do|does|did|have|has|had|are|is|was|were|can|could|would|will|shall|should|may|"
    r"what|when|where|why|how|which|who|whose)\b",
    re.I,
)


def _is_question(sentence: str) -> bool:
    """A question is not an assertion, and only assertions can be a diagnosis.

    Without this the guard blocked the agent for doing its job -- "Do you have any
    other symptoms?" tripped `you have`, and each block replaced a clarifying
    question with a dead-end refusal.

    The trade-off: a diagnosis phrased as a question ("Did you know you have
    diabetes?") now gets past the regex layer. That is far rarer than the false
    positives this prevents, and it isn't the only control -- the system prompt
    forbids diagnosing, and no AI clinical content reaches a patient without
    clinician approval (SAFETY-3).
    """
    stripped = sentence.strip()
    return stripped.endswith("?") or bool(_QUESTION_OPENER.match(stripped))


def check_text(text: str) -> tuple[str, str] | None:
    """Returns (category, matched_snippet) for the first violation found, or None.

    Checked per sentence so one interrogative clause doesn't exempt an assertion
    elsewhere in the same reply -- "Got it. You have a UTI." still blocks.
    """
    for sentence in _SENTENCE_SPLIT.split(text):
        if not sentence.strip() or _is_question(sentence):
            continue
        for category, pattern in ALL_PATTERNS:
            m = pattern.search(sentence)
            if m:
                return category, m.group(0)
    return None


def guard(text: str, *, session_id: str | None = None) -> str:
    """Returns `text` unchanged, or SAFE_FALLBACK_LINE if it trips a pattern.
    Logs every block (section 9.3: "log the blocked text, increment a metric" --
    the metric is this structured log event, aggregated by whatever reads
    structlog output; section 20/admin dashboard surfaces the rate)."""
    violation = check_text(text)
    if violation is None:
        return text
    category, snippet = violation
    logger.warning("output_guard_blocked", category=category, matched=snippet, session_id=session_id, blocked_text=text)
    return SAFE_FALLBACK_LINE
