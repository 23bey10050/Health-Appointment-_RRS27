"""Structured generation with repair-then-fallback -- IMPLEMENTATION.md section 11
preamble, verbatim policy: "request strict JSON, validate against a Pydantic model,
and on validation failure run one repair attempt (...). On second failure, fall
back to the next provider. On total failure, write state='failed' with
generation_error and surface a manual-entry UI. Never crash, never show a
half-parsed artifact."

generate_structured() never raises for a model- or provider-side failure -- it
always returns a GenerationResult, with `data=None` and `generation_error` set on
total failure. Callers (services/summaries.py) persist that outcome as-is.
"""

from dataclasses import dataclass

from pydantic import BaseModel, ValidationError

from app.llm.router import AllProvidersExhaustedError, Tier, get_router

REPAIR_TEMPERATURE = 0.0


@dataclass
class GenerationResult:
    data: BaseModel | None
    provider: str | None
    model: str | None
    prompt_version: str
    input_tokens: int
    output_tokens: int
    latency_ms: int
    generation_error: str | None


def _try_parse(schema: type[BaseModel], text: str) -> BaseModel | None:
    try:
        return schema.model_validate_json(text)
    except (ValidationError, ValueError):
        return None


async def generate_structured(
    tier: Tier,
    schema: type[BaseModel],
    *,
    system_prompt: str,
    user_prompt: str,
    prompt_version: str,
    temperature: float = 0.2,
    max_tokens: int = 1500,
) -> GenerationResult:
    router = get_router()
    excluded: set[str] = set()
    errors: list[str] = []
    total_input = total_output = total_latency = 0

    for _round in range(router.chain_length(tier)):
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ]
        try:
            result = await router.complete(
                tier, messages, temperature=temperature, max_tokens=max_tokens, json_mode=True, exclude=excluded
            )
        except AllProvidersExhaustedError as e:
            errors.append(str(e))
            break

        total_input += result.input_tokens
        total_output += result.output_tokens
        total_latency += result.latency_ms

        parsed = _try_parse(schema, result.text)
        if parsed is not None:
            return GenerationResult(
                parsed, result.provider, result.model, prompt_version, total_input, total_output, total_latency, None
            )

        # One repair attempt. No `exclude` here -- breaker/bucket state usually
        # keeps this on the same provider that just answered, which is the point:
        # "repair" means "try again", not "immediately give up on this provider".
        repair_messages = messages + [
            {"role": "assistant", "content": result.text},
            {
                "role": "user",
                "content": (
                    "Your previous output was invalid JSON. Return only valid JSON "
                    f"matching this schema: {schema.model_json_schema()}"
                ),
            },
        ]
        try:
            repair_result = await router.complete(
                tier,
                repair_messages,
                temperature=REPAIR_TEMPERATURE,
                max_tokens=max_tokens,
                json_mode=True,
                exclude=excluded,
            )
        except AllProvidersExhaustedError as e:
            errors.append(str(e))
            break

        total_input += repair_result.input_tokens
        total_output += repair_result.output_tokens
        total_latency += repair_result.latency_ms

        parsed = _try_parse(schema, repair_result.text)
        if parsed is not None:
            return GenerationResult(
                parsed,
                repair_result.provider,
                repair_result.model,
                prompt_version,
                total_input,
                total_output,
                total_latency,
                None,
            )

        errors.append(f"{result.provider}/{result.model}: invalid JSON on both the original and repair attempt")
        excluded.add(result.provider)

    return GenerationResult(
        None, None, None, prompt_version, total_input, total_output, total_latency, "; ".join(errors) or "no providers configured"
    )
