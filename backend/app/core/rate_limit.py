"""Redis-backed fixed-window rate limiting -- IMPLEMENTATION.md section 16 Phase 7
"rate limiting." This is a separate concern from the LLM router's TokenBucket
(llm/router.py), which manages per-provider capacity; this is abuse protection on
endpoints that are cheap to call but expensive to serve (auth brute-forcing,
spinning up voice sessions that each load an STT/TTS/LLM pipeline).

A plain INCR+EXPIRE fixed window, not sliding-window or leaky-bucket: simple,
correct enough for abuse protection (as opposed to precise fairness), and it's
one round-trip per request.
"""

from fastapi import HTTPException, Request, status
from redis.asyncio import Redis

from app.deps import get_redis_client


def rate_limit(key_prefix: str, *, limit: int, window_seconds: int):
    """FastAPI dependency factory. Keys on client IP."""

    async def _dep(request: Request) -> None:
        redis: Redis = get_redis_client()
        ip = request.client.host if request.client else "unknown"
        key = f"ratelimit:{key_prefix}:{ip}"
        current = await redis.incr(key)
        if current == 1:
            await redis.expire(key, window_seconds)
        if current > limit:
            raise HTTPException(
                status.HTTP_429_TOO_MANY_REQUESTS, "Too many requests, please try again later."
            )

    return _dep
