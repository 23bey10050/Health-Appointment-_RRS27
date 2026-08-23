"""DB engine helper for Celery tasks -- deliberately NOT app.db.session.SessionLocal.

Every task in this package is a sync Celery task wrapping `asyncio.run(_something_async())`.
Celery's prefork worker calls the same task function many times over a worker
process's life, and `asyncio.run()` creates and tears down a brand new event loop
on every call. app.db.session.engine is a module-level singleton whose asyncpg
connection pool gets bound to whichever event loop was running the first time it
was used -- reuse it from a second `asyncio.run()` and asyncpg raises
"Future attached to a different loop" the moment a pooled connection is checked out.

The fix: no pool. Each task's top-level async function opens one `worker_engine()`
(NullPool -- no connections outlive a single checkout) for its whole run, builds a
sessionmaker from it, and lets `async with worker_engine()` dispose it on exit.
Tasks here run at most every 15s and do a handful of queries each, so the cost of
fresh asyncpg connections per run is trivial next to the correctness win.
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
