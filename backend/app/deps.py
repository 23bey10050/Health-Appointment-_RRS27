import asyncio
from collections.abc import AsyncIterator

from redis.asyncio import Redis

from app.config import get_settings
from app.db.session import get_session  # noqa: F401  (re-exported for convenience)

settings = get_settings()

# Keyed by running event loop, not a single bare global: a Redis client's
# connections are bound to the loop that created them, so a naive singleton
# breaks the moment it's reused from a different loop (e.g. pytest-asyncio's
# fresh loop per test). In production there's exactly one loop for the process
# lifetime, so this still resolves to one client, created once.
_redis_by_loop: dict[int, Redis] = {}


def get_redis_client() -> Redis:
    loop_key = id(asyncio.get_event_loop())
    client = _redis_by_loop.get(loop_key)
    if client is None:
        client = Redis.from_url(settings.REDIS_URL, decode_responses=True)
        _redis_by_loop[loop_key] = client
    return client


async def get_redis() -> AsyncIterator[Redis]:
    yield get_redis_client()
