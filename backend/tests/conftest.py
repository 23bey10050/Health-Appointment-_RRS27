import os
import uuid
from datetime import date, datetime, time, timedelta

from sqlalchemy.engine import make_url

# Compute the test DB URL from the raw environment -- not via get_settings(), which
# is @lru_cache'd, so whatever it returns on its first call is frozen for the rest
# of this process. Then overwrite DATABASE_URL itself, *before* anything imports
# app.config, so that first (and only) get_settings() call already resolves to the
# test database. Everything downstream that reads settings.DATABASE_URL -- the ORM
# models' own module imports, and notably app/workers/db.py::worker_engine, which
# test_outbox_idempotency.py exercises directly -- then transparently talks to
# clinic_test too, with no test-only branches in application code.
_raw_base_url = make_url(os.environ["DATABASE_URL"])
# str(url)/repr(url) mask the password as "***" (SQLAlchemy makes URLs log-safe by
# default) -- exactly wrong for a string about to be used to connect or override an
# env var with, so every URL built for actual use goes through render_as_string.
TEST_DATABASE_URL = _raw_base_url.set(database=f"{_raw_base_url.database}_test").render_as_string(
    hide_password=False
)
os.environ["DATABASE_URL"] = TEST_DATABASE_URL

import pytest  # noqa: E402
import pytest_asyncio  # noqa: E402
from sqlalchemy import text  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine  # noqa: E402
from sqlalchemy.pool import NullPool  # noqa: E402

from app.config import get_settings  # noqa: E402
from app.core.security import hash_password  # noqa: E402
from app.models import Base  # noqa: E402
from app.models.doctor import DoctorProfile, DoctorWorkingHours  # noqa: E402
from app.models.enums import UserRole  # noqa: E402
from app.models.user import User  # noqa: E402

settings = get_settings()
_base_url = make_url(settings.DATABASE_URL)
assert _base_url.database == f"{_raw_base_url.database}_test", (
    "get_settings() was cached before the DATABASE_URL override above -- something "
    "imported app.config (directly or transitively) at module load time before this "
    "file's override ran. Move that import below the override or into a fixture."
)


@pytest.fixture(scope="session", autouse=True)
def _prepare_test_db():
    """Create (or reset) clinic_test and migrate it to head, once per test session."""
    import asyncio

    async def _create_db():
        # _raw_base_url, not _base_url: the latter's .database is already "clinic_test"
        # post-override (see the module-level assert above) -- deriving the target
        # name from it again would produce "clinic_test_test".
        admin_url = _raw_base_url.set(database="postgres").render_as_string(hide_password=False)
        admin_engine = create_async_engine(admin_url, isolation_level="AUTOCOMMIT")
        async with admin_engine.connect() as conn:
            dbname = _base_url.database
            await conn.execute(text(f'DROP DATABASE IF EXISTS "{dbname}" WITH (FORCE)'))
            await conn.execute(text(f'CREATE DATABASE "{dbname}"'))
        await admin_engine.dispose()

    asyncio.run(_create_db())

    os.environ["ALEMBIC_DATABASE_URL"] = TEST_DATABASE_URL
    from alembic import command
    from alembic.config import Config

    backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    cfg = Config(os.path.join(backend_dir, "alembic.ini"))
    cfg.set_main_option("script_location", os.path.join(backend_dir, "alembic"))
    command.upgrade(cfg, "head")


@pytest.fixture(scope="session")
def test_engine():
    # NullPool: the concurrency test needs 50 simultaneous real connections racing
    # each other, not queued behind a small pool.
    engine = create_async_engine(TEST_DATABASE_URL, poolclass=NullPool)
    yield engine


@pytest.fixture(scope="session")
def test_sessionmaker(test_engine):
    return async_sessionmaker(bind=test_engine, expire_on_commit=False)


@pytest_asyncio.fixture(autouse=True)
async def _clean_tables(test_sessionmaker):
    """Truncate every app table before each test -- cheap given the schema's size,
    and it keeps tests independent without per-test transaction-rollback tricks
    (which would defeat the concurrency test's need for real committed races)."""
    async with test_sessionmaker() as session:
        table_names = ", ".join(f'"{t.name}"' for t in Base.metadata.sorted_tables)
        await session.execute(text(f"TRUNCATE {table_names} RESTART IDENTITY CASCADE"))
        await session.commit()
    yield


@pytest_asyncio.fixture
async def db_session(test_sessionmaker):
    async with test_sessionmaker() as session:
        yield session


@pytest_asyncio.fixture
async def seeded_doctor(db_session: AsyncSession) -> uuid.UUID:
    """A doctor accepting patients, working every day 06:00-22:00 clinic-local, no
    leave -- broad enough that tests don't have to reason about the exact window."""
    user = User(
        email=f"doctor-{uuid.uuid4().hex[:10]}@test.example",
        full_name="Dr. Test Doctor",
        password_hash=hash_password("irrelevant"),
        role=UserRole.doctor,
    )
    db_session.add(user)
    await db_session.flush()
    db_session.add(
        DoctorProfile(
            user_id=user.id,
            specialisation="General Medicine",
            slot_duration_min=20,
            buffer_min=0,
            is_accepting=True,
        )
    )
    for weekday in range(7):
        db_session.add(
            DoctorWorkingHours(
                doctor_id=user.id,
                weekday=weekday,
                start_time=time(6, 0),
                end_time=time(22, 0),
            )
        )
    await db_session.commit()
    return user.id


@pytest_asyncio.fixture
async def seeded_patient(db_session: AsyncSession) -> uuid.UUID:
    user = User(
        email=f"patient-{uuid.uuid4().hex[:10]}@test.example",
        full_name="Test Patient",
        password_hash=hash_password("irrelevant"),
        role=UserRole.patient,
    )
    db_session.add(user)
    await db_session.commit()
    return user.id


@pytest_asyncio.fixture
async def seeded_admin(db_session: AsyncSession) -> uuid.UUID:
    user = User(
        email=f"admin-{uuid.uuid4().hex[:10]}@test.example",
        full_name="Test Admin",
        password_hash=hash_password("irrelevant"),
        role=UserRole.admin,
    )
    db_session.add(user)
    await db_session.commit()
    return user.id


def future_slot_start(*, days_ahead: int = 1, hour: int = 10) -> datetime:
    from app.services.availability import CLINIC_TZ

    target_date = date.today() + timedelta(days=days_ahead)
    return datetime.combine(target_date, time(hour, 0), tzinfo=CLINIC_TZ)
