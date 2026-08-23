"""Booking core. hold_slot is IMPLEMENTATION.md section 7.1 -- the exclusion constraint
(migration 0001, appointments_no_overlap) is the actual source of truth; everything
here just fails gracefully when it fires. The one departure from the spec's literal
code is `session.begin()` -> `start_clean_transaction(session)`: callers (API
endpoints, the leave-conflict handler, the voice agent's tool loop in Phase 5) often
read something on the same session before holding a slot, which leaves it mid an
autobegun transaction -- see db/session.py::start_clean_transaction for why a bare
`session.begin()` then raises. The advisory lock, assertions, insert, and
IntegrityError handling are unchanged.
"""

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import ConflictError, NotFoundError, PermissionDeniedError, SlotUnavailableError
from app.db.session import start_clean_transaction
from app.models.appointment import Appointment
from app.models.enums import AppointmentStatus
from app.services.availability import assert_not_on_leave as _assert_not_on_leave
from app.services.availability import assert_within_working_hours as _assert_within_working_hours
from app.services.notification import enqueue_email


def _dispatch_calendar_sync(appt: Appointment) -> None:
    # Deferred import: services/ has no import-time dependency on workers/Celery,
    # only a call-time one, and Celery's own app construction (app.workers.celery_app)
    # itself imports this module's sibling tasks -- keeping this lazy avoids giving
    # that cycle a second entry point to worry about.
    from app.workers.calendar_jobs import sync_appointment_calendar

    sync_appointment_calendar.delay(str(appt.id), str(appt.patient_id), str(appt.doctor_id))


def _dispatch_calendar_delete(appt: Appointment) -> None:
    from app.workers.calendar_jobs import delete_appointment_calendar

    delete_appointment_calendar.delay(str(appt.id), str(appt.patient_id), str(appt.doctor_id))


async def hold_slot(
    session: AsyncSession,
    doctor_id: uuid.UUID,
    patient_id: uuid.UUID,
    start_at: datetime,
    duration_min: int,
    ttl_seconds: int = 300,
) -> Appointment:
    end_at = start_at + timedelta(minutes=duration_min)
    async with await start_clean_transaction(session):
        # Advisory lock reduces constraint-violation churn under load.
        # Not a correctness mechanism -- the exclusion constraint is.
        await session.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:k, 0))"),
            {"k": f"{doctor_id}:{start_at.date().isoformat()}"},
        )
        await _assert_within_working_hours(session, doctor_id, start_at, end_at)
        await _assert_not_on_leave(session, doctor_id, start_at.date())
        appt = Appointment(
            doctor_id=doctor_id,
            patient_id=patient_id,
            start_at=start_at,
            end_at=end_at,
            status=AppointmentStatus.held,
            hold_expires_at=datetime.now(UTC) + timedelta(seconds=ttl_seconds),
        )
        session.add(appt)
        try:
            await session.flush()
        except IntegrityError as e:
            if "appointments_no_overlap" in str(e.orig):
                raise SlotUnavailableError(
                    "That time was just taken. Let me find you another one."
                ) from e
            raise
    return appt


async def _enqueue_booking_confirmed_emails(session: AsyncSession, appt: Appointment) -> None:
    # Deferred imports: these models/relationships aren't needed by hold_slot's hot path.
    from app.models.doctor import DoctorProfile
    from app.models.user import User

    patient = await session.get(User, appt.patient_id)
    doctor_profile = await session.get(DoctorProfile, appt.doctor_id)
    doctor_user = await session.get(User, appt.doctor_id) if doctor_profile else None

    if patient:
        await enqueue_email(
            session,
            idempotency_key=f"booking_confirm_patient:{appt.id}",
            to_email=patient.email,
            template="booking_confirmation_patient",
            context={
                "appointment_id": str(appt.id),
                "patient_name": patient.full_name,
                "doctor_name": doctor_user.full_name if doctor_user else "your doctor",
                "start_at": appt.start_at.isoformat(),
            },
        )
    if doctor_user:
        await enqueue_email(
            session,
            idempotency_key=f"booking_confirm_doctor:{appt.id}",
            to_email=doctor_user.email,
            template="booking_confirmation_doctor",
            context={
                "appointment_id": str(appt.id),
                "doctor_name": doctor_user.full_name,
                "patient_name": patient.full_name if patient else "a patient",
                "start_at": appt.start_at.isoformat(),
            },
        )


async def confirm_booking(
    session: AsyncSession,
    appointment_id: uuid.UUID,
    patient_id: uuid.UUID,
    reason_text: str | None = None,
) -> Appointment:
    """Idempotent: confirming an already-confirmed hold owned by this patient is a no-op success.

    `reason_text` is the flattened symptom form from the web booking flow. The
    voice path leaves it None -- it has a full transcript instead, which
    generate_pre_visit_summary prefers.
    """
    async with await start_clean_transaction(session):
        appt = await session.get(Appointment, appointment_id, with_for_update=True)
        if appt is None:
            raise NotFoundError("Appointment not found")
        if appt.patient_id != patient_id:
            raise PermissionDeniedError("This appointment does not belong to you")

        if appt.status == AppointmentStatus.confirmed:
            return appt

        if appt.status != AppointmentStatus.held:
            raise ConflictError("This hold is no longer active")

        # Written before the status flips, so the row is never observably
        # confirmed without the symptoms the doctor's pre-visit panel needs.
        if reason_text:
            appt.reason_text = reason_text

        now = datetime.now(UTC)
        if appt.hold_expires_at is not None and appt.hold_expires_at < now:
            appt.status = AppointmentStatus.cancelled
            raise SlotUnavailableError("That hold expired. Please pick a time again.")

        appt.status = AppointmentStatus.confirmed
        appt.hold_expires_at = None
        appt.updated_at = now
        await session.flush()
        await _enqueue_booking_confirmed_emails(session, appt)

    _dispatch_calendar_sync(appt)  # after commit: never call an external API inside the booking transaction
    return appt


async def cancel_appointment(
    session: AsyncSession,
    appointment_id: uuid.UUID,
    cancelled_by: uuid.UUID,
    reason: str | None = None,
) -> Appointment:
    from app.models.user import User

    async with await start_clean_transaction(session):
        appt = await session.get(Appointment, appointment_id, with_for_update=True)
        if appt is None:
            raise NotFoundError("Appointment not found")
        if appt.status in (AppointmentStatus.cancelled, AppointmentStatus.completed):
            return appt  # already terminal -- treat as idempotent

        appt.status = AppointmentStatus.cancelled
        appt.cancelled_at = datetime.now(UTC)
        appt.cancelled_by = cancelled_by
        appt.cancellation_reason = reason
        appt.updated_at = appt.cancelled_at

        patient = await session.get(User, appt.patient_id)
        if patient:
            await enqueue_email(
                session,
                idempotency_key=f"appointment_cancelled:{appt.id}:{appt.cancelled_at.timestamp()}",
                to_email=patient.email,
                template="appointment_cancelled",
                context={
                    "appointment_id": str(appt.id),
                    "patient_name": patient.full_name,
                    "start_at": appt.start_at.isoformat(),
                    "reason": reason,
                },
            )

    _dispatch_calendar_delete(appt)
    return appt


async def reschedule_appointment(
    session: AsyncSession,
    appointment_id: uuid.UUID,
    actor_id: uuid.UUID,
    new_start_at: datetime,
) -> Appointment:
    """Hold the new slot before releasing the old one -- a failed hold must leave
    the existing booking untouched."""
    from app.models.user import User

    old = await session.get(Appointment, appointment_id)
    if old is None:
        raise NotFoundError("Appointment not found")
    if old.status != AppointmentStatus.confirmed:
        raise ConflictError("Only a confirmed appointment can be rescheduled")
    doctor_id, patient_id_, duration_min = (
        old.doctor_id,
        old.patient_id,
        int((old.end_at - old.start_at).total_seconds() // 60),
    )
    # session.get() above auto-begins a transaction; close it out (nothing was written)
    # before hold_slot opens its own explicit `session.begin()`, or that raises
    # InvalidRequestError("A transaction is already begun on this Session").
    await session.rollback()

    new_appt = await hold_slot(session, doctor_id, patient_id_, new_start_at, duration_min)

    async with await start_clean_transaction(session):
        old = await session.get(Appointment, appointment_id, with_for_update=True)
        new_appt = await session.get(Appointment, new_appt.id, with_for_update=True)

        old.status = AppointmentStatus.rescheduled
        old.cancelled_at = datetime.now(UTC)
        old.cancelled_by = actor_id
        old.cancellation_reason = "rescheduled"
        old.updated_at = old.cancelled_at

        new_appt.status = AppointmentStatus.confirmed
        new_appt.hold_expires_at = None
        new_appt.rescheduled_from = old.id
        new_appt.updated_at = datetime.now(UTC)
        await session.flush()

        patient = await session.get(User, new_appt.patient_id)
        if patient:
            await enqueue_email(
                session,
                idempotency_key=f"appointment_rescheduled:{new_appt.id}",
                to_email=patient.email,
                template="appointment_rescheduled",
                context={
                    "old_appointment_id": str(old.id),
                    "new_appointment_id": str(new_appt.id),
                    "patient_name": patient.full_name,
                    "new_start_at": new_appt.start_at.isoformat(),
                },
            )

    _dispatch_calendar_delete(old)
    _dispatch_calendar_sync(new_appt)
    return new_appt
