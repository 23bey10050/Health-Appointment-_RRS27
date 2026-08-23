import uuid
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.core.rate_limit import rate_limit
from app.deps import get_redis_client

pytestmark = pytest.mark.asyncio


def _fake_request(ip: str = "1.2.3.4"):
    # rate_limit only reads request.client.host -- a plain stand-in is enough,
    # no need to construct a real Starlette Request/ASGI scope.
    return SimpleNamespace(client=SimpleNamespace(host=ip))


async def test_allows_up_to_limit_then_blocks():
    prefix = f"test-{uuid.uuid4().hex[:8]}"  # unique key namespace per test run
    dep = rate_limit(prefix, limit=3, window_seconds=60)
    req = _fake_request()
    try:
        for _ in range(3):
            await dep(req)  # must not raise

        with pytest.raises(HTTPException) as exc_info:
            await dep(req)
        assert exc_info.value.status_code == 429
    finally:
        await get_redis_client().delete(f"ratelimit:{prefix}:1.2.3.4")


async def test_different_ips_tracked_independently():
    prefix = f"test-{uuid.uuid4().hex[:8]}"
    dep = rate_limit(prefix, limit=1, window_seconds=60)
    try:
        await dep(_fake_request("1.1.1.1"))
        await dep(_fake_request("2.2.2.2"))  # independent bucket, must not be blocked

        with pytest.raises(HTTPException):
            await dep(_fake_request("1.1.1.1"))
    finally:
        redis = get_redis_client()
        await redis.delete(f"ratelimit:{prefix}:1.1.1.1")
        await redis.delete(f"ratelimit:{prefix}:2.2.2.2")


async def test_window_expiry_resets_the_count():
    prefix = f"test-{uuid.uuid4().hex[:8]}"
    dep = rate_limit(prefix, limit=1, window_seconds=1)
    req = _fake_request("3.3.3.3")
    try:
        await dep(req)
        with pytest.raises(HTTPException):
            await dep(req)

        import asyncio

        await asyncio.sleep(1.2)
        await dep(req)  # window elapsed -- allowed again
    finally:
        await get_redis_client().delete(f"ratelimit:{prefix}:3.3.3.3")
