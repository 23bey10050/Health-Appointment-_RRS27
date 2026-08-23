"""LLM router -- IMPLEMENTATION.md section 3 ("LLM router") and section 9. Free
tiers are the binding constraint on the whole project, so this is load-bearing:
token-bucket limiting per (provider, model) seeded from configured RPM/TPM/RPD,
a circuit breaker (3 consecutive failures -> open 60s -> half-open probe), and a
fixed fallback chain per tier so one provider's outage or 429 is invisible to the
caller.

RPM/TPM/RPD below are hardcoded, not settings, on purpose: section 3 calls these
"approximate free limits as of mid-2026 -- verify at build time, they move". They're
provider facts, not deployment config -- a clinic operator tuning CLINIC_NAME or
SLOT_HOLD_TTL_SECONDS has no reason to also carry Groq's current rate limit in their
.env. Update the numbers here directly when a provider changes its free tier.
"""

import time
from collections import deque
from dataclasses import dataclass
from enum import Enum
from functools import lru_cache

import structlog

from app.config import get_settings
from app.llm.providers.base import LLMProvider, LLMProviderError, LLMResponse, RateLimitError
from app.llm.providers.cerebras import CerebrasProvider
from app.llm.providers.gemini import GeminiProvider
from app.llm.providers.groq import GroqProvider
from app.llm.providers.ollama import OllamaProvider

logger = structlog.get_logger(__name__)
settings = get_settings()


class Tier(str, Enum):
    FAST = "fast"
    REASON = "reason"
    LOCAL = "local"


class AllProvidersExhaustedError(Exception):
    def __init__(self, tier: Tier, attempts: list[str]):
        self.tier = tier
        self.attempts = attempts
        super().__init__(f"All providers exhausted for tier {tier.value}: {'; '.join(attempts)}")


@dataclass
class LLMResult:
    text: str
    provider: str
    model: str
    input_tokens: int
    output_tokens: int
    latency_ms: int


class TokenBucket:
    """Sliding-window RPM + a rolling day counter for RPD. In-process and
    single-instance on purpose: this project's deployment story (section 3) is one
    Docker Compose stack, one api process -- a Redis-backed distributed limiter
    would be solving a problem this deployment doesn't have."""

    def __init__(self, rpm: int, rpd: int | None):
        self.rpm = rpm
        self.rpd = rpd
        self._request_times: deque[float] = deque()
        self._day_count = 0
        self._day_start = time.monotonic()

    def try_acquire(self) -> bool:
        now = time.monotonic()
        while self._request_times and now - self._request_times[0] > 60:
            self._request_times.popleft()
        if len(self._request_times) >= self.rpm:
            return False
        if self.rpd is not None:
            if now - self._day_start > 86400:
                self._day_start = now
                self._day_count = 0
            if self._day_count >= self.rpd:
                return False
        self._request_times.append(now)
        self._day_count += 1
        return True


class CircuitState(str, Enum):
    closed = "closed"
    open = "open"
    half_open = "half_open"


class CircuitBreaker:
    def __init__(self, failure_threshold: int = 3, open_seconds: float = 60.0):
        self.failure_threshold = failure_threshold
        self.open_seconds = open_seconds
        self.state = CircuitState.closed
        self.consecutive_failures = 0
        self._opened_at: float | None = None

    def can_attempt(self) -> bool:
        if self.state == CircuitState.closed:
            return True
        if self.state == CircuitState.open:
            if time.monotonic() - self._opened_at >= self.open_seconds:
                self.state = CircuitState.half_open
                return True
            return False
        return True  # half_open: let the probe through

    def record_success(self) -> None:
        self.consecutive_failures = 0
        self.state = CircuitState.closed
        self._opened_at = None

    def record_failure(self) -> None:
        self.consecutive_failures += 1
        if self.state == CircuitState.half_open or self.consecutive_failures >= self.failure_threshold:
            self.state = CircuitState.open
            self._opened_at = time.monotonic()


@dataclass
class ProviderSlot:
    key: str
    provider: LLMProvider
    model: str
    rpm: int
    rpd: int | None


def _build_chains() -> dict[Tier, list[ProviderSlot]]:
    return {
        Tier.FAST: [
            ProviderSlot("groq", GroqProvider(), settings.GROQ_FAST_MODEL, rpm=30, rpd=1000),
            ProviderSlot("gemini", GeminiProvider(), settings.GEMINI_FAST_MODEL, rpm=15, rpd=1500),
            ProviderSlot("cerebras", CerebrasProvider(), settings.CEREBRAS_FAST_MODEL, rpm=30, rpd=None),
            ProviderSlot("ollama", OllamaProvider(), settings.OLLAMA_FAST_MODEL, rpm=1000, rpd=None),
        ],
        Tier.REASON: [
            ProviderSlot("groq", GroqProvider(), settings.GROQ_REASON_MODEL, rpm=30, rpd=1000),
            ProviderSlot("gemini", GeminiProvider(), settings.GEMINI_REASON_MODEL, rpm=15, rpd=1500),
            ProviderSlot("ollama", OllamaProvider(), settings.OLLAMA_REASON_MODEL, rpm=1000, rpd=None),
        ],
        Tier.LOCAL: [
            ProviderSlot("ollama", OllamaProvider(), settings.OLLAMA_FAST_MODEL, rpm=1000, rpd=None),
        ],
    }


class LLMRouter:
    def __init__(self, chains: dict[Tier, list[ProviderSlot]] | None = None):
        # `chains` override exists for tests (tests/test_llm_router.py): fake
        # providers exercise the breaker/bucket/fallback logic without any network
        # calls or real API keys. Production always uses the real provider chains.
        self._chains = chains if chains is not None else _build_chains()
        self._breakers: dict[str, CircuitBreaker] = {}
        self._buckets: dict[str, TokenBucket] = {}
        for tier, chain in self._chains.items():
            for slot in chain:
                bucket_key = f"{tier.value}:{slot.key}:{slot.model}"
                self._breakers[bucket_key] = CircuitBreaker()
                self._buckets[bucket_key] = TokenBucket(slot.rpm, slot.rpd)

    def chain_length(self, tier: Tier) -> int:
        return len(self._chains[tier])

    def status(self) -> list[dict]:
        """Live introspection of the actual singleton router's state -- for the
        admin health dashboard (section 15: "LLM quota consumption per provider").
        Real numbers from the in-process breakers/buckets, not derived/estimated."""
        rows = []
        for tier, chain in self._chains.items():
            for slot in chain:
                bucket_key = f"{tier.value}:{slot.key}:{slot.model}"
                breaker = self._breakers[bucket_key]
                bucket = self._buckets[bucket_key]
                rows.append(
                    {
                        "tier": tier.value,
                        "provider": slot.key,
                        "model": slot.model,
                        "circuit_state": breaker.state.value,
                        "consecutive_failures": breaker.consecutive_failures,
                        "requests_last_minute": len(bucket._request_times),
                        "rpm_limit": bucket.rpm,
                        "requests_today": bucket._day_count,
                        "rpd_limit": bucket.rpd,
                    }
                )
        return rows

    async def complete(
        self,
        tier: Tier,
        messages: list[dict[str, str]],
        *,
        temperature: float = 0.2,
        max_tokens: int = 1024,
        json_mode: bool = False,
        exclude: set[str] | None = None,
    ) -> LLMResult:
        """`exclude`: provider keys (e.g. {"groq"}) to skip entirely -- used by
        llm/generate.py to force a genuinely different provider after a round's
        main-plus-repair attempts both come back invalid JSON (section 11 preamble:
        "on second failure, fall back to the next provider")."""
        exclude = exclude or set()
        attempts: list[str] = []
        for slot in self._chains[tier]:
            if slot.key in exclude:
                continue
            bucket_key = f"{tier.value}:{slot.key}:{slot.model}"
            breaker = self._breakers[bucket_key]
            bucket = self._buckets[bucket_key]

            if not breaker.can_attempt():
                attempts.append(f"{slot.key}/{slot.model}: circuit open")
                continue
            if not bucket.try_acquire():
                attempts.append(f"{slot.key}/{slot.model}: local rate limit reached")
                continue

            try:
                response: LLMResponse = await slot.provider.complete(
                    model=slot.model,
                    messages=messages,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    json_mode=json_mode,
                )
            except RateLimitError as e:
                # A 429 is the provider behaving correctly under load, not failing --
                # don't trip the breaker for it, just move to the next provider.
                attempts.append(f"{slot.key}/{slot.model}: 429")
                logger.warning(
                    "llm_call_rate_limited", provider=slot.key, model=slot.model, tier=tier.value,
                    retry_after=e.retry_after_seconds,
                )
                continue
            except LLMProviderError as e:
                attempts.append(f"{slot.key}/{slot.model}: {e}")
                if e.retryable:
                    breaker.record_failure()
                logger.warning(
                    "llm_call_failed", provider=slot.key, model=slot.model, tier=tier.value,
                    retryable=e.retryable, error=str(e),
                )
                continue

            breaker.record_success()
            logger.info(
                "llm_call_succeeded", provider=slot.key, model=slot.model, tier=tier.value,
                latency_ms=response.latency_ms, input_tokens=response.input_tokens,
                output_tokens=response.output_tokens,
            )
            return LLMResult(
                text=response.text,
                provider=slot.key,
                model=slot.model,
                input_tokens=response.input_tokens,
                output_tokens=response.output_tokens,
                latency_ms=response.latency_ms,
            )

        raise AllProvidersExhaustedError(tier, attempts)


@lru_cache
def get_router() -> LLMRouter:
    return LLMRouter()
