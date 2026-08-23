"""Common provider interface -- every provider in this package (groq, gemini,
cerebras, ollama) implements `complete()` with this exact signature so the router
never needs to know which one it's talking to.
"""

from dataclasses import dataclass
from typing import Protocol


@dataclass
class LLMResponse:
    text: str
    input_tokens: int
    output_tokens: int
    latency_ms: int


class LLMProviderError(Exception):
    """Base for all provider failures. `retryable=False` short-circuits the
    router's fallback chain for errors retrying won't fix (bad request, auth)."""

    def __init__(self, message: str, *, retryable: bool = True):
        super().__init__(message)
        self.retryable = retryable


class RateLimitError(LLMProviderError):
    def __init__(self, message: str, *, retry_after_seconds: float | None = None):
        super().__init__(message, retryable=True)
        self.retry_after_seconds = retry_after_seconds


class ProviderUnavailableError(LLMProviderError):
    """Network failure, 5xx, timeout -- circuit-breaker-worthy but not the
    caller's fault, unlike a 4xx from a malformed request."""


class LLMProvider(Protocol):
    async def complete(
        self,
        *,
        model: str,
        messages: list[dict[str, str]],
        temperature: float = 0.2,
        max_tokens: int = 1024,
        json_mode: bool = False,
    ) -> LLMResponse: ...
