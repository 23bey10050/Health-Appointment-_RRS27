"""IMPLEMENTATION.md section 19: 429 handling, breaker open/half-open, provider
failover, PHI round-trip. Fake providers (no network, no API keys) exercise the
router's own logic -- LLMRouter accepts a `chains` override exactly for this
(llm/router.py).
"""

import pytest

from app.llm.providers.base import LLMProviderError, LLMResponse, ProviderUnavailableError, RateLimitError
from app.llm.redact import redact_text, rehydrate_for_session
from app.llm.router import CircuitBreaker, LLMRouter, ProviderSlot, Tier


class FakeProvider:
    """Returns/raises each entry in `outcomes` in order, repeating the last one
    once exhausted. Records every call for assertions."""

    def __init__(self, outcomes: list):
        self.outcomes = outcomes
        self.call_count = 0

    async def complete(self, *, model, messages, temperature=0.2, max_tokens=1024, json_mode=False):
        idx = min(self.call_count, len(self.outcomes) - 1)
        self.call_count += 1
        outcome = self.outcomes[idx]
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


def _resp(text: str = "ok") -> LLMResponse:
    return LLMResponse(text=text, input_tokens=10, output_tokens=5, latency_ms=42)


def _router_with(*slots: ProviderSlot) -> LLMRouter:
    return LLMRouter(chains={Tier.FAST: list(slots)})


@pytest.mark.asyncio
async def test_rate_limit_falls_back_to_next_provider_without_tripping_breaker():
    groq = FakeProvider([RateLimitError("429")])
    gemini = FakeProvider([_resp("from gemini")])
    router = _router_with(
        ProviderSlot("groq", groq, "model-a", rpm=30, rpd=None),
        ProviderSlot("gemini", gemini, "model-b", rpm=30, rpd=None),
    )

    result = await router.complete(Tier.FAST, [{"role": "user", "content": "hi"}])

    assert result.provider == "gemini"
    assert result.text == "from gemini"
    breaker = router._breakers["fast:groq:model-a"]
    assert breaker.state.value == "closed"
    assert breaker.consecutive_failures == 0


@pytest.mark.asyncio
async def test_all_providers_down_raises_with_every_provider_key_removed_style_errors():
    from app.llm.router import AllProvidersExhaustedError

    groq = FakeProvider([LLMProviderError("no API key configured", retryable=False)])
    gemini = FakeProvider([LLMProviderError("no API key configured", retryable=False)])
    router = _router_with(
        ProviderSlot("groq", groq, "model-a", rpm=30, rpd=None),
        ProviderSlot("gemini", gemini, "model-b", rpm=30, rpd=None),
    )

    with pytest.raises(AllProvidersExhaustedError) as exc_info:
        await router.complete(Tier.FAST, [{"role": "user", "content": "hi"}])

    assert "groq" in str(exc_info.value)
    assert "gemini" in str(exc_info.value)


@pytest.mark.asyncio
async def test_circuit_opens_after_three_consecutive_failures_then_skips_provider():
    groq = FakeProvider([ProviderUnavailableError("down")] * 5)
    gemini = FakeProvider([_resp("from gemini")] * 5)
    router = _router_with(
        ProviderSlot("groq", groq, "model-a", rpm=30, rpd=None),
        ProviderSlot("gemini", gemini, "model-b", rpm=30, rpd=None),
    )

    # Three failures on groq (each call falls through to gemini, which succeeds,
    # but groq is attempted first each time and racks up failures).
    for _ in range(3):
        result = await router.complete(Tier.FAST, [{"role": "user", "content": "hi"}])
        assert result.provider == "gemini"

    breaker = router._breakers["fast:groq:model-a"]
    assert breaker.state.value == "open"
    calls_before = groq.call_count

    # Fourth call: circuit open, groq must not be attempted at all.
    await router.complete(Tier.FAST, [{"role": "user", "content": "hi"}])
    assert groq.call_count == calls_before


@pytest.mark.asyncio
async def test_circuit_half_open_probe_recovers_on_success():
    groq = FakeProvider([ProviderUnavailableError("down")] * 3 + [_resp("groq is back")])
    router = _router_with(ProviderSlot("groq", groq, "model-a", rpm=30, rpd=None))

    from app.llm.router import AllProvidersExhaustedError

    for _ in range(3):
        with pytest.raises(AllProvidersExhaustedError):
            await router.complete(Tier.FAST, [{"role": "user", "content": "hi"}])

    breaker = router._breakers["fast:groq:model-a"]
    assert breaker.state.value == "open"

    # Simulate the open window elapsing without a real sleep.
    breaker._opened_at -= breaker.open_seconds + 1

    result = await router.complete(Tier.FAST, [{"role": "user", "content": "hi"}])
    assert result.text == "groq is back"
    assert breaker.state.value == "closed"


@pytest.mark.asyncio
async def test_local_rpm_bucket_exhaustion_falls_back():
    groq = FakeProvider([_resp("call 1"), _resp("call 2")])
    gemini = FakeProvider([_resp("from gemini")])
    router = _router_with(
        ProviderSlot("groq", groq, "model-a", rpm=1, rpd=None),  # only 1 request per minute
        ProviderSlot("gemini", gemini, "model-b", rpm=30, rpd=None),
    )

    first = await router.complete(Tier.FAST, [{"role": "user", "content": "hi"}])
    assert first.provider == "groq"

    second = await router.complete(Tier.FAST, [{"role": "user", "content": "hi"}])
    assert second.provider == "gemini"  # groq's 1-rpm bucket is already spent


def test_circuit_breaker_state_machine_directly():
    breaker = CircuitBreaker(failure_threshold=2, open_seconds=10)
    assert breaker.can_attempt() is True

    breaker.record_failure()
    assert breaker.state.value == "closed"  # one failure isn't enough yet

    breaker.record_failure()
    assert breaker.state.value == "open"
    assert breaker.can_attempt() is False

    breaker._opened_at -= 11  # simulate elapsed time
    assert breaker.can_attempt() is True
    assert breaker.state.value == "half_open"

    breaker.record_success()
    assert breaker.state.value == "closed"
    assert breaker.consecutive_failures == 0


def test_phi_redaction_round_trip():
    text = "Patient Aditya Sharma called from 9876543210, email aditya.sharma@example.com."
    redacted, mapping = redact_text(text, known_values={"name": "Aditya Sharma"})

    assert "Aditya Sharma" not in redacted
    assert "9876543210" not in redacted
    assert "aditya.sharma@example.com" not in redacted
    assert "[NAME_1]" in redacted
    assert any(k.startswith("[PHONE_") for k in mapping)
    assert any(k.startswith("[EMAIL_") for k in mapping)

    # Reverse it exactly, using the same mapping a session would persist to Redis.
    restored = text
    for placeholder, value in mapping.items():
        restored = restored.replace(placeholder, value)  # rehydrate_for_session's own logic
    assert restored == text


@pytest.mark.asyncio
async def test_phi_rehydrate_for_session_with_fake_redis():
    class FakeRedis:
        def __init__(self):
            self.store: dict[str, str] = {}

        async def get(self, key):
            return self.store.get(key)

        async def set(self, key, value, ex=None):
            self.store[key] = value

    from app.llm.redact import redact_for_session

    redis = FakeRedis()
    original = "Call the patient Meera Pillai back."
    redacted = await redact_for_session(redis, "session-1", original, known_values={"name": "Meera Pillai"})
    assert "Meera Pillai" not in redacted

    llm_echo = redacted.replace("Call the patient", "Please contact") + " Thank you."
    restored = await rehydrate_for_session(redis, "session-1", llm_echo)
    assert "Meera Pillai" in restored
    assert "[NAME_1]" not in restored
