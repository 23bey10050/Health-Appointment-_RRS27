"""IMPLEMENTATION.md section 13.3: generate_pre_visit_summaries, every 10 min --
"Any booked appointment lacking one." Bounded batch per run so a backlog after
downtime doesn't burn a whole day's free-tier quota in one sweep (section 20,
item 2: instrument and respect quota from day one).
"""

import asyncio

import structlog
from redis.asyncio import Redis
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.config import get_settings
from app.models.appointment import Appointment
from app.models.encounter import AISummary
from app.models.enums import AppointmentStatus, SummaryKind
from app.services.summaries import generate_pre_visit_summary
from app.workers.celery_app import celery_app
from app.workers.db import worker_engine

logger = structlog.get_logger(__name__)
settings = get_settings()

BATCH_SIZE = 20


async def _generate_pre_visit_summaries_async() -> int:
    redis = Redis.from_url(settings.REDIS_URL, decode_responses=True)
    generated = 0
    try:
        async with worker_engine() as engine:
            Session = async_sessionmaker(bind=engine, expire_on_commit=False)
            async with Session() as session:
                already_summarized = select(AISummary.appointment_id).where(
                    AISummary.kind == SummaryKind.pre_visit, AISummary.appointment_id.is_not(None)
                )
                pending = list(
                    await session.scalars(
                        select(Appointment.id)
                        .where(
                            Appointment.status.in_([AppointmentStatus.confirmed, AppointmentStatus.completed]),
                            Appointment.id.not_in(already_summarized),
                        )
                        .order_by(Appointment.created_at)
                        .limit(BATCH_SIZE)
                    )
                )

            for appointment_id in pending:
                async with Session() as session:
                    try:
                        await generate_pre_visit_summary(session, redis, appointment_id)
                        generated += 1
                    except Exception as e:
                        logger.error(
                            "pre_visit_summary_generation_failed", appointment_id=str(appointment_id), error=str(e)
                        )
    finally:
        await redis.aclose()
    return generated


@celery_app.task(name="app.workers.summary_jobs.generate_pre_visit_summaries")
def generate_pre_visit_summaries() -> int:
    return asyncio.run(_generate_pre_visit_summaries_async())
