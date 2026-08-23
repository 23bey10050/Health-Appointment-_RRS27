"""DB engine helper for Celery tasks -- deliberately NOT app.db.session.SessionLocal.

Every task here is a sync Celery task wrapping `asyncio.run(...)`, and Celery's
prefork worker calls each task many times per process. Each `asyncio.run()` makes
a new event loop, but app.db.session.engine is a singleton whose asyncpg pool
binds to the first loop that used it -- reusing it from a second run raises
"Future attached to a different loop" when a connection is checked out.

The fix is to use no pool. Each task opens one `worker_engine()` (NullPool) for
its run and disposes it on exit. These tasks run every 15s at most and do a few
queries each, so fresh connections per run cost little.
"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine
from sqlalchemy.pool import NullPool

from app.config import get_settings

settings = get_settings()


@asynccontextmanager
async def worker_engine() -> AsyncIterator[AsyncEngine]:
    engine = create_async_engine(settings.DATABASE_URL, poolclass=NullPool)
    try:
        yield engine
    finally:
        await engine.dispose()
