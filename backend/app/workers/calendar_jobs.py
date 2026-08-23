"""Calendar reconciliation -- IMPLEMENTATION.md section 13.3, every 6h. Retries
whatever upsert_event_for_user/delete_event_for_user couldn't finish inline
(section 13.2: Calendar is best-effort and never blocks a booking).

Also home to the two fire-and-forget tasks that booking.py dispatches right after
a transaction commits. Section 7.1 is explicit: never call an external API inside
the booking transaction. Handing Celery a task name is a fast, local enqueue (a
Redis write); the actual Google API call happens later, in this worker process,
long after the booking transaction that triggered it is done.
"""

import asyncio
import uuid

import structlog
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.models.notification import CalendarLink
from app.services.calendar import delete_event_for_user, upsert_event_for_user
from app.workers.celery_app import celery_app
from app.workers.db import worker_engine

logger = structlog.get_logger(__name__)
BATCH_SIZE = 100


async def _reconcile_async() -> dict[str, int]:
    counts = {"retried_sync": 0, "retried_delete": 0}

    async with worker_engine() as engine:
        Session = async_sessionmaker(bind=engine, expire_on_commit=False)

        async with Session() as session:
            pending = list(
                await session.scalars(
                    select(CalendarLink)
                    .where(CalendarLink.sync_state.in_(["failed", "pending"]))
                    .limit(BATCH_SIZE)
                )
            )
            to_delete = list(
                await session.scalars(
                    select(CalendarLink).where(CalendarLink.sync_state == "pending_deletion").limit(BATCH_SIZE)
                )
            )
            targets_sync = [(link.appointment_id, link.user_id) for link in pending]
            targets_delete = [(link.appointment_id, link.user_id) for link in to_delete]

        for appointment_id, user_id in targets_sync:
            async with Session() as session:
                await upsert_event_for_user(session, appointment_id, user_id)
            counts["retried_sync"] += 1

        for appointment_id, user_id in targets_delete:
            async with Session() as session:
                await delete_event_for_user(session, appointment_id, user_id)
            counts["retried_delete"] += 1

    return counts


@celery_app.task(name="app.workers.calendar_jobs.reconcile_calendar")
def reconcile_calendar() -> dict[str, int]:
    return asyncio.run(_reconcile_async())


async def _sync_appointment_async(appointment_id: uuid.UUID, patient_id: uuid.UUID, doctor_id: uuid.UUID) -> None:
    # Independent per user: the patient having (or not having) a connected calendar
    # has no bearing on whether the doctor's syncs.
    async with worker_engine() as engine:
        Session = async_sessionmaker(bind=engine, expire_on_commit=False)
        async with Session() as session:
            await upsert_event_for_user(session, appointment_id, patient_id)
        async with Session() as session:
            await upsert_event_for_user(session, appointment_id, doctor_id)


@celery_app.task(name="app.workers.calendar_jobs.sync_appointment_calendar")
def sync_appointment_calendar(appointment_id: str, patient_id: str, doctor_id: str) -> None:
    asyncio.run(_sync_appointment_async(uuid.UUID(appointment_id), uuid.UUID(patient_id), uuid.UUID(doctor_id)))


async def _delete_appointment_async(appointment_id: uuid.UUID, patient_id: uuid.UUID, doctor_id: uuid.UUID) -> None:
    async with worker_engine() as engine:
        Session = async_sessionmaker(bind=engine, expire_on_commit=False)
        async with Session() as session:
            await delete_event_for_user(session, appointment_id, patient_id)
        async with Session() as session:
            await delete_event_for_user(session, appointment_id, doctor_id)


@celery_app.task(name="app.workers.calendar_jobs.delete_appointment_calendar")
def delete_appointment_calendar(appointment_id: str, patient_id: str, doctor_id: str) -> None:
    asyncio.run(_delete_appointment_async(uuid.UUID(appointment_id), uuid.UUID(patient_id), uuid.UUID(doctor_id)))
