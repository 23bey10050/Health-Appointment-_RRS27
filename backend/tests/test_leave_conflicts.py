"""IMPLEMENTATION.md section 19: the impact preview must match what confirm
actually cancels -- these are the same read (see services/leave.py's
_affected_appointments), but this test guards against that invariant drifting
apart as the two functions evolve independently.
"""

from datetime import date, timedelta

import pytest
from sqlalchemy import select

from app.models.appointment import Appointment
from app.models.enums import AppointmentKind, AppointmentStatus
from app.models.notification import EmailOutbox
from app.services.leave import handle_leave_conflicts, preview_leave_conflicts
from tests.conftest import future_slot_start


async def _make_confirmed_appointment(session, doctor_id, patient_id, start_at):
    appt = Appointment(
        doctor_id=doctor_id,
        patient_id=patient_id,
        start_at=start_at,
        end_at=start_at + timedelta(minutes=20),
        status=AppointmentStatus.confirmed,
        kind=AppointmentKind.routine,
    )
    session.add(appt)
    await session.commit()
    await session.refresh(appt)
    return appt


@pytest.mark.asyncio
async def test_preview_matches_what_confirm_cancels(
    db_session, test_sessionmaker, seeded_doctor, seeded_patient, seeded_admin
):
    leave_start = date.today() + timedelta(days=3)
    leave_end = date.today() + timedelta(days=5)

    in_range = await _make_confirmed_appointment(
        db_session, seeded_doctor, seeded_patient, future_slot_start(days_ahead=4, hour=11)
    )
    out_of_range = await _make_confirmed_appointment(
        db_session, seeded_doctor, seeded_patient, future_slot_start(days_ahead=10, hour=11)
    )

    async with test_sessionmaker() as preview_session:
        preview = await preview_leave_conflicts(preview_session, seeded_doctor, leave_start, leave_end)
    preview_ids = {a.appointment.id for a in preview}
    assert preview_ids == {in_range.id}
    assert out_of_range.id not in preview_ids

    async with test_sessionmaker() as confirm_session:
        await handle_leave_conflicts(
            confirm_session, seeded_doctor, leave_start, leave_end, "family emergency", seeded_admin
        )

    async with test_sessionmaker() as check_session:
        cancelled = (
            await check_session.scalars(
                select(Appointment).where(Appointment.status == AppointmentStatus.cancelled)
            )
        ).all()
        cancelled_ids = {a.id for a in cancelled}
        assert cancelled_ids == preview_ids, "confirm must cancel exactly what preview said it would"

        for appt in cancelled:
            assert appt.cancellation_reason == "doctor_unavailable"

        still_confirmed = await check_session.get(Appointment, out_of_range.id)
        assert still_confirmed.status == AppointmentStatus.confirmed

        outbox_row = await check_session.scalar(
            select(EmailOutbox).where(EmailOutbox.idempotency_key == f"leave_cancel:{in_range.id}")
        )
        assert outbox_row is not None
        assert outbox_row.template == "appointment_cancelled_doctor_leave"
        assert outbox_row.context["rebook_token"]


@pytest.mark.asyncio
async def test_leave_with_no_bookings_is_a_no_op_cancel(db_session, seeded_doctor, seeded_admin):
    leave_start = date.today() + timedelta(days=20)
    leave_end = date.today() + timedelta(days=22)

    leave = await handle_leave_conflicts(db_session, seeded_doctor, leave_start, leave_end, None, seeded_admin)
    assert leave.affected_appointments_handled is True
