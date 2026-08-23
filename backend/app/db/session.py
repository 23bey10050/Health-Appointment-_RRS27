from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.config import get_settings

settings = get_settings()

engine = create_async_engine(
    settings.DATABASE_URL,
    pool_pre_ping=True,
    # Sized for a managed Postgres free tier (Neon), not a local container: the
    # previous 10+20 allowed 30 connections from the API alone, which exhausts
    # the cap once the worker is also connected. pool_recycle matters too --
    # Neon closes idle connections server-side, and without recycling those
    # dead handles surface as intermittent ConnectionDoesNotExistError.
    pool_size=settings.DB_POOL_SIZE,
    max_overflow=settings.DB_MAX_OVERFLOW,
    pool_recycle=settings.DB_POOL_RECYCLE_SECONDS,
)

SessionLocal = async_sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autoflush=False,
)


async def get_session() -> AsyncIterator[AsyncSession]:
    async with SessionLocal() as session:
        yield session


async def start_clean_transaction(session: AsyncSession):
    """Return a `session.begin()` context manager, closing out any transaction that
    autobegin already opened on this session (e.g. from a prior read).

    AsyncSession.begin() raises InvalidRequestError if a transaction -- explicit or
    autobegun -- is already open. A fresh per-request session never hits this, but
    any service function that reads before it writes, or a caller (like the voice
    agent's tool-calling loop, which chains several service calls on one session
    within a turn) that queried the session earlier, will. Nothing has been written
    at that point, so rolling back is always safe.
    """
    if session.in_transaction():
        await session.rollback()
    return session.begin()
