"""Hold reaper -- IMPLEMENTATION.md section 7.1: Celery Beat runs this every 30s to
flip expired `held` appointments to `cancelled`. Availability computation and
hold_slot's stale-row cleanup at read/write time (services/availability.py,
services/booking.py) mean a lagging reaper never blocks a live booking -- this task
only exists to keep the `appointments` table itself tidy.
"""

import asyncio
from datetime import UTC, datetime

from sqlalchemy import update
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.models.appointment import Appointment
from app.models.enums import AppointmentStatus
from app.workers.celery_app import celery_app
from app.workers.db import worker_engine


async def _expire_holds_async() -> int:
    now = datetime.now(UTC)
    async with worker_engine() as engine:
        Session = async_sessionmaker(bind=engine, expire_on_commit=False)
        async with Session() as session, session.begin():
            result = await session.execute(
                update(Appointment)
                .where(
                    Appointment.status == AppointmentStatus.held,
                    Appointment.hold_expires_at.is_not(None),
                    Appointment.hold_expires_at < now,
                )
                .values(status=AppointmentStatus.cancelled, cancelled_at=now, cancellation_reason="hold_expired")
            )
    return result.rowcount or 0


@celery_app.task(name="app.workers.holds.expire_holds")
def expire_holds() -> int:
    return asyncio.run(_expire_holds_async())
