"""Outbox dispatcher -- IMPLEMENTATION.md section 13.1: polls email_outbox every 15s,
sends via the configured provider, retries with exponential backoff, dead-letters
after max_attempts. Each row's status transition is its own short transaction so a
slow send (network to Brevo/SMTP) never holds a DB row lock.
"""

import asyncio
import random
import uuid
from datetime import UTC, datetime, timedelta

import structlog
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.models.appointment import Appointment
from app.models.enums import OutboxStatus
from app.models.hospital import Hospital
from app.models.notification import EmailOutbox
from app.models.user import User
from app.services.calendar_ics import build_ics
from app.services.email_render import render_email
from app.services.notification import ICS_TEMPLATES, EmailSendError, send_rendered_email
from app.workers.celery_app import celery_app
from app.workers.db import worker_engine

logger = structlog.get_logger(__name__)

BATCH_SIZE = 50
BACKOFF_JITTER_SECONDS = 60

# Which outbox context key holds the appointment id an .ics should describe -- most
# templates use "appointment_id"; reschedule enqueues both old and new and cares
# about the new one (see services/booking.py::reschedule_appointment).
_ICS_APPOINTMENT_ID_KEY = {
    "booking_confirmation_patient": "appointment_id",
    "booking_confirmation_doctor": "appointment_id",
    "appointment_rescheduled": "new_appointment_id",
}


async def _build_ics_for(Session: async_sessionmaker, template: str, context: dict) -> bytes | None:
    key = _ICS_APPOINTMENT_ID_KEY.get(template)
    raw_id = context.get(key) if key else None
    if not raw_id:
        return None

    async with Session() as session:
        appt = await session.get(Appointment, uuid.UUID(raw_id))
        if appt is None:
            return None
        doctor_user = await session.get(User, appt.doctor_id)
        hospital = await session.get(Hospital, appt.hospital_id) if appt.hospital_id else None
        return build_ics(
            appointment_id=appt.id,
            summary=f"Appointment with {doctor_user.full_name if doctor_user else 'your doctor'}",
            start_at=appt.start_at,
            end_at=appt.end_at,
            location=hospital.address if hospital else None,
        )


ClaimedRow = tuple[uuid.UUID, str, str, dict, int, int]  # id, to_email, template, context, attempts, max_attempts


async def _claim_batch(Session: async_sessionmaker) -> list[ClaimedRow]:
    """Mark up to BATCH_SIZE due rows 'sending' and hand them back, all inside one
    short transaction -- skip_locked means a second dispatcher run (shouldn't happen
    with one beat schedule, but cheap insurance) never double-claims a row."""
    async with Session() as session, session.begin():
        rows = list(
            await session.scalars(
                select(EmailOutbox)
                .where(
                    EmailOutbox.status.in_([OutboxStatus.pending, OutboxStatus.failed]),
                    EmailOutbox.next_attempt_at <= datetime.now(UTC),
                )
                .order_by(EmailOutbox.created_at)
                .limit(BATCH_SIZE)
                .with_for_update(skip_locked=True)
            )
        )
        for row in rows:
            row.status = OutboxStatus.sending
        await session.flush()
        # Detach the values we need before the session closes -- callers use
        # these across further short-lived sessions, not this one.
        claimed = [
            (row.id, row.to_email, row.template, row.context, row.attempts, row.max_attempts) for row in rows
        ]
    return claimed


async def _mark_sent(Session: async_sessionmaker, outbox_id: uuid.UUID, provider_message_id: str) -> None:
    async with Session() as session, session.begin():
        row = await session.get(EmailOutbox, outbox_id, with_for_update=True)
        row.status = OutboxStatus.sent
        row.provider_message_id = provider_message_id
        row.last_error = None


async def _mark_failed_or_dead(
    Session: async_sessionmaker, outbox_id: uuid.UUID, attempts: int, max_attempts: int, error: str
) -> str:
    next_attempts = attempts + 1
    async with Session() as session, session.begin():
        row = await session.get(EmailOutbox, outbox_id, with_for_update=True)
        row.attempts = next_attempts
        row.last_error = error[:2000]
        if next_attempts >= max_attempts:
            row.status = OutboxStatus.dead
            return "dead"
        row.status = OutboxStatus.failed
        backoff_minutes = 2**next_attempts
        jitter = random.uniform(0, BACKOFF_JITTER_SECONDS)
        row.next_attempt_at = datetime.now(UTC) + timedelta(minutes=backoff_minutes, seconds=jitter)
        return "failed"


async def _dispatch_async() -> dict[str, int]:
    counts = {"sent": 0, "failed": 0, "dead": 0}

    async with worker_engine() as engine:
        Session = async_sessionmaker(bind=engine, expire_on_commit=False)
        claimed = await _claim_batch(Session)

        for outbox_id, to_email, template, context, attempts, max_attempts in claimed:
            try:
                subject, html, text = render_email(template, context)
                ics = None
                if template in ICS_TEMPLATES:
                    # Best-effort: a missing/cancelled appointment by send time
                    # shouldn't block the email itself, just the attachment.
                    try:
                        ics = await _build_ics_for(Session, template, context)
                    except Exception:
                        logger.warning("ics_build_failed", outbox_id=str(outbox_id), template=template)

                message_id = await send_rendered_email(
                    to_email=to_email, subject=subject, html=html, text=text, ics_attachment=ics
                )
                await _mark_sent(Session, outbox_id, message_id)
                counts["sent"] += 1
            except EmailSendError as e:
                outcome = await _mark_failed_or_dead(Session, outbox_id, attempts, max_attempts, str(e))
                counts[outcome] += 1
                if outcome == "dead":
                    logger.error(
                        "email_dead_lettered", outbox_id=str(outbox_id), template=template, error=str(e)
                    )
            except Exception as e:
                # Rendering bugs, bad template names, etc: still go through the same
                # retry/dead-letter path rather than crashing the whole batch.
                outcome = await _mark_failed_or_dead(
                    Session, outbox_id, attempts, max_attempts, f"unexpected: {e}"
                )
                counts[outcome] += 1
                logger.error(
                    "email_dispatch_unexpected_error", outbox_id=str(outbox_id), template=template, error=str(e)
                )

    return counts


@celery_app.task(name="app.workers.email_dispatch.dispatch_emails")
def dispatch_emails() -> dict[str, int]:
    return asyncio.run(_dispatch_async())
