"""Google Gemini. Different wire format from the OpenAI-compatible providers --
system messages become `systemInstruction`, roles are user/model not user/assistant,
and content lives in a nested contents[].parts[].text tree.

Section 3's redaction rule exists specifically because of this provider: Gemini's
free tier may use prompts for training, so PHI must never reach it unredacted
(llm/redact.py, applied by the router before any hosted provider call).
"""

import time

import httpx

from app.config import get_settings
from app.llm.providers.base import (
    LLMProviderError,
    LLMResponse,
    ProviderUnavailableError,
    RateLimitError,
)

settings = get_settings()


def _to_gemini_contents(messages: list[dict[str, str]]) -> tuple[str | None, list[dict]]:
    system_parts = []
    contents = []
    for m in messages:
        if m["role"] == "system":
            system_parts.append(m["content"])
        else:
            role = "model" if m["role"] == "assistant" else "user"
            contents.append({"role": role, "parts": [{"text": m["content"]}]})
    return ("\n\n".join(system_parts) or None, contents)


class GeminiProvider:
    def __init__(self):
        self.api_key = settings.GEMINI_API_KEY

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

        system_instruction, contents = _to_gemini_contents(messages)
        payload: dict = {
            "contents": contents,
            "generationConfig": {"temperature": temperature, "maxOutputTokens": max_tokens},
        }
        if system_instruction:
            payload["systemInstruction"] = {"parts": [{"text": system_instruction}]}
        if json_mode:
            payload["generationConfig"]["responseMimeType"] = "application/json"

        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"

        start = time.monotonic()
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.post(url, params={"key": self.api_key}, json=payload)
        except httpx.TimeoutException as e:
            raise ProviderUnavailableError(f"timeout: {e}") from e
        except httpx.HTTPError as e:
            raise ProviderUnavailableError(f"connection error: {e}") from e
        latency_ms = int((time.monotonic() - start) * 1000)

        if resp.status_code == 429:
            raise RateLimitError("429 from Gemini")
        if resp.status_code >= 500:
            raise ProviderUnavailableError(f"{resp.status_code} from Gemini: {resp.text[:300]}")
        if resp.status_code >= 400:
            raise LLMProviderError(f"{resp.status_code} from Gemini: {resp.text[:300]}", retryable=False)

        body = resp.json()
        candidates = body.get("candidates") or []
        if not candidates:
            # Safety-filtered or empty response -- not retryable, a different prompt
            # won't magically pass Gemini's own content filter on retry.
            raise LLMProviderError(f"Gemini returned no candidates: {body.get('promptFeedback')}", retryable=False)

        parts = candidates[0].get("content", {}).get("parts", [])
        text = "".join(p.get("text", "") for p in parts)
        usage = body.get("usageMetadata", {})
        return LLMResponse(
            text=text,
            input_tokens=usage.get("promptTokenCount", 0),
            output_tokens=usage.get("candidatesTokenCount", 0),
            latency_ms=latency_ms,
        )
