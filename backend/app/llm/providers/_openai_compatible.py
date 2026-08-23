"""Shared implementation for providers exposing an OpenAI-style chat/completions
endpoint (Groq, Cerebras). Not a public provider itself -- groq.py and cerebras.py
each construct one of these with their own base URL and API key.
"""

import time

import httpx

from app.llm.providers.base import (
    LLMProviderError,
    LLMResponse,
    ProviderUnavailableError,
    RateLimitError,
)


class OpenAICompatibleProvider:
    def __init__(self, *, base_url: str, api_key: str, timeout: float = 30.0):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout

    async def complete(
        self,
        *,
        model: str,
        messages: list[dict[str, str]],
        temperature: float = 0.2,
        max_tokens: int = 1024,
        json_mode: bool = False,
    ) -> LLMResponse:
        if not self.api_key:
            raise LLMProviderError("no API key configured", retryable=False)

        if json_mode:
            # Groq and other OpenAI-compatible APIs return a 400 for
            # response_format=json_object unless the word "json" appears in the
            # messages. Handled here so the prompt templates don't each have to
            # carry a provider-specific requirement.
            messages = [*messages, {"role": "system", "content": "Respond with valid JSON only."}]

        payload = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        if json_mode:
            payload["response_format"] = {"type": "json_object"}

        start = time.monotonic()
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                resp = await client.post(
                    f"{self.base_url}/chat/completions",
                    headers={"Authorization": f"Bearer {self.api_key}"},
                    json=payload,
                )
        except httpx.TimeoutException as e:
            raise ProviderUnavailableError(f"timeout: {e}") from e
        except httpx.HTTPError as e:
            raise ProviderUnavailableError(f"connection error: {e}") from e
        latency_ms = int((time.monotonic() - start) * 1000)

        if resp.status_code == 429:
            retry_after = resp.headers.get("retry-after")
            raise RateLimitError(
                f"429 from {self.base_url}", retry_after_seconds=float(retry_after) if retry_after else None
            )
        if resp.status_code >= 500:
            raise ProviderUnavailableError(f"{resp.status_code} from {self.base_url}: {resp.text[:300]}")
        if resp.status_code >= 400:
            raise LLMProviderError(
                f"{resp.status_code} from {self.base_url}: {resp.text[:300]}", retryable=False
            )

        body = resp.json()
        choice = body["choices"][0]["message"]["content"]
        usage = body.get("usage", {})
        return LLMResponse(
            text=choice,
            input_tokens=usage.get("prompt_tokens", 0),
            output_tokens=usage.get("completion_tokens", 0),
            latency_ms=latency_ms,
        )
