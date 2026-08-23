"""Doctor leave with existing bookings -- IMPLEMENTATION.md section 7.3.

Two entry points:
  preview_leave_conflicts  -- read-only, drives the admin confirmation screen.
  handle_leave_conflicts   -- the six numbered steps, run after admin confirms.

Both must agree on which appointments are "affected" (test_leave_conflicts.py
asserts the preview matches what confirm actually cancels), so they share
_affected_appointments.
"""

import uuid
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import ConflictError, NotFoundError
from app.core.security import create_rebook_token
from app.db.session import start_clean_transaction
from app.models.appointment import Appointment
from app.models.doctor import DoctorLeave, DoctorProfile
from app.models.enums import AppointmentStatus
from app.models.user import User
from app.services.availability import CLINIC_TZ, compute_availability
from app.services.notification import enqueue_email

REBOOK_LOOKAHEAD_DAYS = 14
ALT_SPECIALITY_WINDOW_DAYS = 3
MAX_ALTERNATIVES = 3


@dataclass
class AffectedAppointment:
    appointment: Appointment
    patient_name: str
    patient_email: str
    alternatives: list[dict]


async def _affected_appointments(
    session: AsyncSession, doctor_id: uuid.UUID, start_date: date, end_date: date
) -> list[Appointment]:
    range_start = datetime.combine(start_date, datetime.min.time(), tzinfo=CLINIC_TZ)
    range_end = datetime.combine(end_date, datetime.max.time(), tzinfo=CLINIC_TZ)
    rows = await session.scalars(
        select(Appointment)
        .where(
            Appointment.doctor_id == doctor_id,
            Appointment.status == AppointmentStatus.confirmed,
            Appointment.start_at < range_end.astimezone(UTC),
            Appointment.end_at > range_start.astimezone(UTC),
        )
        .order_by(Appointment.start_at)
    )
    return list(rows)


async def _find_alternatives(
    session: AsyncSession, appt: Appointment, doctor: DoctorProfile, leave_end: date
) -> list[dict]:
    alternatives: list[dict] = []

    same_doctor_slots = await compute_availability(
        session, doctor.user_id, leave_end + timedelta(days=1), leave_end + timedelta(days=REBOOK_LOOKAHEAD_DAYS)
    )
    doctor_user = await session.get(User, doctor.user_id)
    for slot in same_doctor_slots[:MAX_ALTERNATIVES]:
        alternatives.append(
            {
                "doctor_id": str(doctor.user_id),
                "doctor_name": doctor_user.full_name if doctor_user else "",
                "start_at": slot.isoformat(),
            }
        )

    if len(alternatives) >= MAX_ALTERNATIVES:
        return alternatives[:MAX_ALTERNATIVES]

    orig_date = appt.start_at.astimezone(CLINIC_TZ).date()
    window_from = orig_date - timedelta(days=ALT_SPECIALITY_WINDOW_DAYS)
    window_to = orig_date + timedelta(days=ALT_SPECIALITY_WINDOW_DAYS)

    other_doctors = await session.scalars(
        select(DoctorProfile).where(
            DoctorProfile.specialisation == doctor.specialisation,
            DoctorProfile.hospital_id == doctor.hospital_id,
            DoctorProfile.user_id != doctor.user_id,
            DoctorProfile.is_accepting.is_(True),
        )
    )
    for other in other_doctors:
        if len(alternatives) >= MAX_ALTERNATIVES:
            break
        other_user = await session.get(User, other.user_id)
        slots = await compute_availability(session, other.user_id, window_from, window_to)
        for slot in slots:
            if len(alternatives) >= MAX_ALTERNATIVES:
                break
            alternatives.append(
                {
                    "doctor_id": str(other.user_id),
                    "doctor_name": other_user.full_name if other_user else "",
                    "start_at": slot.isoformat(),
                }
            )

    return alternatives[:MAX_ALTERNATIVES]


async def preview_leave_conflicts(
    session: AsyncSession, doctor_id: uuid.UUID, start_date: date, end_date: date
) -> list[AffectedAppointment]:
    doctor = await session.get(DoctorProfile, doctor_id)
    if doctor is None:
        raise NotFoundError("Doctor not found")

    appts = await _affected_appointments(session, doctor_id, start_date, end_date)
    result = []
    for appt in appts:
        patient = await session.get(User, appt.patient_id)
        alternatives = await _find_alternatives(session, appt, doctor, end_date)
        result.append(
            AffectedAppointment(
                appointment=appt,
                patient_name=patient.full_name if patient else "Unknown",
                patient_email=patient.email if patient else "",
                alternatives=alternatives,
            )
        )
    return result


def _rebook_token(appointment_id: uuid.UUID) -> str:
    """Signed token for the one-click rebook link. The redemption endpoint that
    consumes this lands with the email templates (notification service, Phase 2)."""
    return create_rebook_token(appointment_id=appointment_id)


async def handle_leave_conflicts(
    session: AsyncSession,
    doctor_id: uuid.UUID,
    start_date: date,
    end_date: date,
    reason: str | None,
    created_by: uuid.UUID,
) -> DoctorLeave:
    if end_date < start_date:
        raise ConflictError("Leave end date must be on or after the start date")

    async with await start_clean_transaction(session):
        doctor = await session.get(DoctorProfile, doctor_id)
        if doctor is None:
            raise NotFoundError("Doctor not found")

        leave = DoctorLeave(
            doctor_id=doctor_id,
            start_date=start_date,
            end_date=end_date,
            reason=reason,
            created_by=created_by,
        )
        session.add(leave)

        # Step 1: select affected appointments FOR UPDATE.
        range_start = datetime.combine(start_date, datetime.min.time(), tzinfo=CLINIC_TZ)
        range_end = datetime.combine(end_date, datetime.max.time(), tzinfo=CLINIC_TZ)
        appts = list(
            await session.scalars(
                select(Appointment)
                .where(
                    Appointment.doctor_id == doctor_id,
                    Appointment.status == AppointmentStatus.confirmed,
                    Appointment.start_at < range_end.astimezone(UTC),
                    Appointment.end_at > range_start.astimezone(UTC),
                )
                .with_for_update()
            )
        )

        for appt in appts:
            # Step 2: cancel.
            appt.status = AppointmentStatus.cancelled
            appt.cancelled_at = datetime.now(UTC)
            appt.cancelled_by = created_by
            appt.cancellation_reason = "doctor_unavailable"
            appt.updated_at = appt.cancelled_at

            # Step 3: up to 3 alternative slots.
            alternatives = await _find_alternatives(session, appt, doctor, end_date)

            # Step 4: outbox row with a signed one-click rebook link.
            patient = await session.get(User, appt.patient_id)
            if patient:
                await enqueue_email(
                    session,
                    idempotency_key=f"leave_cancel:{appt.id}",
                    to_email=patient.email,
                    template="appointment_cancelled_doctor_leave",
                    context={
                        "appointment_id": str(appt.id),
                        "patient_name": patient.full_name,
                        "start_at": appt.start_at.isoformat(),
                        "alternatives": alternatives,
                        "rebook_token": _rebook_token(appt.id),
                    },
                )

            # Step 5: calendar deletion. Mark any existing link for pickup by
            # reconcile_calendar (every 6h) as a safety net; the direct dispatch
            # below after commit is what actually makes this prompt in practice.
            from app.models.notification import CalendarLink

            links = await session.scalars(
                select(CalendarLink).where(CalendarLink.appointment_id == appt.id)
            )
            for link in links:
                link.sync_state = "pending_deletion"

        # Step 6.
        leave.affected_appointments_handled = True
        await session.flush()

    for appt in appts:
        # After commit: never call an external API inside the leave transaction
        # (same rule as booking.py's confirm/cancel/reschedule).
        from app.workers.calendar_jobs import delete_appointment_calendar

        delete_appointment_calendar.delay(str(appt.id), str(appt.patient_id), str(appt.doctor_id))

    return leave
