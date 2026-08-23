"""PHI redaction before any hosted-provider call -- IMPLEMENTATION.md section 3:
"Gemini's free tier may use prompts for training. This is why PHI redaction is
mandatory before any hosted call, not optional" (section 20, item 7).

Two passes, not one general-purpose NER model:
  1. Known-value substitution. We're never redacting an arbitrary stranger's free
     text -- every call site knows exactly whose data this is (the patient on the
     appointment, the session), so their name/phone/email get exact-matched and
     replaced. This is more reliable than NER for the values we actually have.
  2. Pattern-based catch-all (email, Indian mobile, Aadhaar/PAN-shaped numbers) for
     anything mentioned that isn't already in `known_values` -- a doctor's name the
     patient volunteers, a relative's phone number, etc.

The mapping is pure and returned to the caller rather than persisted here; the
Redis-backed session mapping (store on redact, rehydrate on the way back) lives in
redact_for_session/rehydrate_for_session below.
"""

import json
import re

from pydantic import BaseModel
from redis.asyncio import Redis

_EMAIL_RE = re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b")
_INDIAN_MOBILE_RE = re.compile(r"\b(?:\+91[-\s]?)?[6-9]\d{9}\b")
_AADHAAR_RE = re.compile(r"\b\d{4}\s\d{4}\s\d{4}\b")
_PAN_RE = re.compile(r"\b[A-Z]{5}\d{4}[A-Z]\b")

_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("EMAIL", _EMAIL_RE),
    ("PHONE", _INDIAN_MOBILE_RE),
    ("ID", _AADHAAR_RE),
    ("ID", _PAN_RE),
]

REDIS_TTL_SECONDS = 3600


def redact_text(text: str, *, known_values: dict[str, str] | None = None) -> tuple[str, dict[str, str]]:
    """Pure function: returns (redacted_text, {placeholder: original_value}).
    `known_values` example: {"name": "Aditya Sharma", "phone": "+91 98765 43210"}."""
    mapping: dict[str, str] = {}
    counters: dict[str, int] = {}
    result = text

    def _placeholder(label: str, value: str) -> str:
        counters[label] = counters.get(label, 0) + 1
        p = f"[{label}_{counters[label]}]"
        mapping[p] = value
        return p

    # Longest values first so a full name isn't left partially exposed by matching
    # a shorter known value inside it first.
    for label, value in sorted((known_values or {}).items(), key=lambda kv: -len(kv[1] or "")):
        if value and value in result:
            result = result.replace(value, _placeholder(label.upper(), value))

    for label, pattern in _PATTERNS:
        result = pattern.sub(lambda m, lbl=label: _placeholder(lbl, m.group(0)), result)

    return result, mapping


def _redis_key(session_key: str) -> str:
    return f"phi_map:{session_key}"


async def redact_for_session(
    redis: Redis, session_key: str, text: str, *, known_values: dict[str, str] | None = None
) -> str:
    """Redact `text` and merge any newly-discovered mappings into the session's
    running placeholder map (a session sees the same identifiers turn-over-turn --
    the map must accumulate, not reset)."""
    redacted, new_mapping = redact_text(text, known_values=known_values)
    if new_mapping:
        key = _redis_key(session_key)
        existing_raw = await redis.get(key)
        combined = json.loads(existing_raw) if existing_raw else {}
        combined.update(new_mapping)
        await redis.set(key, json.dumps(combined), ex=REDIS_TTL_SECONDS)
    return redacted


async def rehydrate_for_session(redis: Redis, session_key: str, text: str) -> str:
    """Reverse redact_for_session's substitution using the stored mapping. A cold
    or expired map (Redis restarted, TTL elapsed) means placeholders stay literal
    in the output rather than raising -- callers should treat that as an unlikely
    but non-fatal degradation, not crash a summary over it."""
    raw = await redis.get(_redis_key(session_key))
    if not raw:
        return text
    mapping = json.loads(raw)
    result = text
    for placeholder, value in mapping.items():
        result = result.replace(placeholder, value)
    return result


async def _rehydrate_value(redis: Redis, session_key: str, value):
    if isinstance(value, str):
        return await rehydrate_for_session(redis, session_key, value)
    if isinstance(value, list):
        return [await _rehydrate_value(redis, session_key, v) for v in value]
    if isinstance(value, dict):
        return {k: await _rehydrate_value(redis, session_key, v) for k, v in value.items()}
    return value


async def rehydrate_model(redis: Redis, session_key: str, model: BaseModel) -> BaseModel:
    """The LLM's response can echo redacted placeholders back in its own words (a
    post-visit summary saying "we discussed [NAME_1]'s symptoms"), so structured
    generation results need the same walk-and-replace treatment as raw text.
    Recurses through every string field, including inside nested models and lists
    (e.g. PostVisitSummary.medication_schedule[].why)."""
    data = model.model_dump()
    rehydrated = await _rehydrate_value(redis, session_key, data)
    return type(model).model_validate(rehydrated)
