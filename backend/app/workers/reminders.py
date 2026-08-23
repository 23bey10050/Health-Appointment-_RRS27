"""Appointment and medication reminders -- IMPLEMENTATION.md section 13.3.

Both tasks enqueue into email_outbox rather than sending directly (same transactional
pattern as booking/leave), and both rely on the outbox's idempotency_key uniqueness
to make generous, overlapping query windows safe: catching the same appointment or
medication dose in two consecutive runs enqueues the same key twice, and the second
insert is a silent no-op (services/notification.py::enqueue_email).
"""

import asyncio
from datetime import UTC, datetime, timedelta

import structlog
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.models.appointment import Appointment
from app.models.encounter import Prescription
from app.models.enums import AppointmentStatus
from app.models.notification import MedicationReminder
from app.models.user import User
from app.services.notification import enqueue_email
from app.workers.celery_app import celery_app
from app.workers.db import worker_engine

logger = structlog.get_logger(__name__)


async def _generate_appointment_reminders_async() -> dict[str, int]:
    now = datetime.now(UTC)
    windows = {
        "appointment_reminder_24h": (now + timedelta(hours=23), now + timedelta(hours=25)),
        "appointment_reminder_2h": (now + timedelta(hours=1, minutes=30), now + timedelta(hours=2, minutes=30)),
    }
    counts = {k: 0 for k in windows}

    async with worker_engine() as engine:
        Session = async_sessionmaker(bind=engine, expire_on_commit=False)
        async with Session() as session, session.begin():
            for template, (window_start, window_end) in windows.items():
                appts = await session.scalars(
                    select(Appointment).where(
                        Appointment.status == AppointmentStatus.confirmed,
                        Appointment.start_at >= window_start,
                        Appointment.start_at < window_end,
                    )
                )
                for appt in appts:
                    patient = await session.get(User, appt.patient_id)
                    doctor = await session.get(User, appt.doctor_id)
                    if not patient:
                        continue
                    await enqueue_email(
                        session,
                        idempotency_key=f"{template}:{appt.id}",
                        to_email=patient.email,
                        template=template,
                        context={
                            "appointment_id": str(appt.id),
                            "patient_name": patient.full_name,
                            "doctor_name": doctor.full_name if doctor else "your doctor",
                            "start_at": appt.start_at.isoformat(),
                        },
                    )
                    counts[template] += 1
    return counts


@celery_app.task(name="app.workers.reminders.generate_appointment_reminders")
def generate_appointment_reminders() -> dict[str, int]:
    return asyncio.run(_generate_appointment_reminders_async())


async def _send_medication_reminders_async() -> int:
    now = datetime.now(UTC)
    sent = 0
    async with worker_engine() as engine:
        Session = async_sessionmaker(bind=engine, expire_on_commit=False)
        async with Session() as session, session.begin():
            due = await session.scalars(
                select(MedicationReminder)
                .where(MedicationReminder.sent_at.is_(None), MedicationReminder.scheduled_at <= now)
                .with_for_update(skip_locked=True)
                .limit(200)
            )
            for reminder in due:
                patient = await session.get(User, reminder.patient_id)
                prescription = await session.get(Prescription, reminder.prescription_id)
                if not patient or not prescription:
                    reminder.sent_at = now  # nothing sensible to send; don't retry forever
                    continue
                await enqueue_email(
                    session,
                    idempotency_key=f"medication_reminder:{reminder.id}",
                    to_email=patient.email,
                    template="medication_reminder",
                    context={
                        "patient_name": patient.full_name,
                        "drug_name": prescription.drug_name,
                        "strength": prescription.strength,
                        "with_food": prescription.relation_to_food,
                        "instructions": prescription.instructions,
                    },
                )
                reminder.sent_at = now
                sent += 1
    return sent


@celery_app.task(name="app.workers.reminders.send_medication_reminders")
def send_medication_reminders() -> int:
    return asyncio.run(_send_medication_reminders_async())
