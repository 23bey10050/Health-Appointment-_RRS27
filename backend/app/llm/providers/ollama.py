"""Local Ollama -- the "LOCAL" tier floor per IMPLEMENTATION.md section 3: unlimited,
no quota, slower. No API key, no rate limits; unreachable (not installed / not
running) is the only realistic failure mode, always a ProviderUnavailableError.
"""

import time

import httpx

from app.config import get_settings
from app.llm.providers.base import LLMResponse, ProviderUnavailableError

settings = get_settings()


class OllamaProvider:
    def __init__(self):
        self.base_url = settings.OLLAMA_BASE_URL.rstrip("/")

    async def complete(
        self,
        *,
        model: str,
        messages: list[dict[str, str]],
        temperature: float = 0.2,
        max_tokens: int = 1024,
        json_mode: bool = False,
    ) -> LLMResponse:
        payload = {
            "model": model,
            "messages": messages,
            "stream": False,
            "options": {"temperature": temperature, "num_predict": max_tokens},
        }
        if json_mode:
            payload["format"] = "json"

        start = time.monotonic()
        try:
            async with httpx.AsyncClient(timeout=60.0) as client:
                resp = await client.post(f"{self.base_url}/api/chat", json=payload)
        except httpx.HTTPError as e:
            raise ProviderUnavailableError(f"Ollama unreachable at {self.base_url}: {e}") from e
        latency_ms = int((time.monotonic() - start) * 1000)

        if resp.status_code >= 400:
            raise ProviderUnavailableError(f"Ollama {resp.status_code}: {resp.text[:300]}")

        body = resp.json()
        return LLMResponse(
            text=body["message"]["content"],
            input_tokens=body.get("prompt_eval_count", 0),
            output_tokens=body.get("eval_count", 0),
            latency_ms=latency_ms,
        )
