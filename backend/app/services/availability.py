"""Availability = working hours - leave - existing appointments - buffers.

Every function here reasons in the clinic's local timezone (DEFAULT_TIMEZONE) for
wall-clock concerns (which weekday, which time-of-day a working-hours window covers)
and in UTC for everything stored or compared against `appointments.start_at/end_at`.
"""

from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.core.errors import SlotUnavailableError
from app.models.appointment import Appointment
from app.models.doctor import DoctorLeave, DoctorProfile, DoctorWorkingHours
from app.models.enums import AppointmentStatus

settings = get_settings()
CLINIC_TZ = ZoneInfo(settings.DEFAULT_TIMEZONE)


def _local(dt: datetime) -> datetime:
    return dt.astimezone(CLINIC_TZ)


async def _working_hours_for(
    session: AsyncSession, doctor_id, weekday: int, on_date: date
) -> list[DoctorWorkingHours]:
    rows = await session.scalars(
        select(DoctorWorkingHours).where(
            DoctorWorkingHours.doctor_id == doctor_id,
            DoctorWorkingHours.weekday == weekday,
            DoctorWorkingHours.valid_from <= on_date,
            (DoctorWorkingHours.valid_until.is_(None)) | (DoctorWorkingHours.valid_until >= on_date),
        )
    )
    return list(rows)


async def is_on_leave(session: AsyncSession, doctor_id, on_date: date) -> bool:
    row = await session.scalar(
        select(DoctorLeave.id).where(
            DoctorLeave.doctor_id == doctor_id,
            DoctorLeave.start_date <= on_date,
            DoctorLeave.end_date >= on_date,
        )
    )
    return row is not None


async def assert_within_working_hours(
    session: AsyncSession, doctor_id, start_at: datetime, end_at: datetime
) -> None:
    local_start = _local(start_at)
    local_end = _local(end_at)
    if local_start.date() != local_end.date():
        raise SlotUnavailableError("That appointment would cross midnight. Please pick another time.")

    weekday = local_start.weekday()  # Monday=0, matches doctor_working_hours convention
    windows = await _working_hours_for(session, doctor_id, weekday, local_start.date())

    for w in windows:
        if w.start_time <= local_start.time() and local_end.time() <= w.end_time:
            return
    raise SlotUnavailableError("That time is outside the doctor's working hours.")


async def assert_not_on_leave(session: AsyncSession, doctor_id, on_date: date) -> None:
    if await is_on_leave(session, doctor_id, on_date):
        raise SlotUnavailableError("The doctor is on leave that day.")


async def _booked_ranges(
    session: AsyncSession, doctor_id, range_start: datetime, range_end: datetime
) -> list[tuple[datetime, datetime]]:
    """Appointments that actually block a slot: confirmed, or held with a live (non-expired) hold.

    A `held` row past its `hold_expires_at` is stale -- the reaper will flip it to
    `cancelled` within 30s (workers/holds.py), but availability must not wait on that.
    """
    now = datetime.now(UTC)
    rows = await session.execute(
        select(Appointment.start_at, Appointment.end_at).where(
            Appointment.doctor_id == doctor_id,
            Appointment.start_at < range_end,
            Appointment.end_at > range_start,
            (Appointment.status == AppointmentStatus.confirmed)
            | (
                (Appointment.status == AppointmentStatus.held)
                & ((Appointment.hold_expires_at.is_(None)) | (Appointment.hold_expires_at > now))
            ),
        )
    )
    return [(r.start_at, r.end_at) for r in rows]


def _overlaps(a_start: datetime, a_end: datetime, b_start: datetime, b_end: datetime) -> bool:
    return a_start < b_end and b_start < a_end


async def compute_availability(
    session: AsyncSession,
    doctor_id,
    date_from: date,
    date_to: date,
    *,
    now: datetime | None = None,
) -> list[datetime]:
    """Free slot start times (UTC) for `doctor_id` between date_from and date_to inclusive."""
    doctor = await session.get(DoctorProfile, doctor_id)
    if doctor is None or not doctor.is_accepting:
        return []

    now = now or datetime.now(CLINIC_TZ)
    slot_len = timedelta(minutes=doctor.slot_duration_min)
    step = timedelta(minutes=doctor.slot_duration_min + doctor.buffer_min)

    range_start = datetime.combine(date_from, time.min, tzinfo=CLINIC_TZ)
    range_end = datetime.combine(date_to, time.max, tzinfo=CLINIC_TZ)
    booked = await _booked_ranges(session, doctor_id, range_start.astimezone(), range_end.astimezone())

    free: list[datetime] = []
    day = date_from
    while day <= date_to:
        if not await is_on_leave(session, doctor_id, day):
            windows = await _working_hours_for(session, doctor_id, day.weekday(), day)
            for w in windows:
                cursor = datetime.combine(day, w.start_time, tzinfo=CLINIC_TZ)
                window_end = datetime.combine(day, w.end_time, tzinfo=CLINIC_TZ)
                while cursor + slot_len <= window_end:
                    slot_end = cursor + slot_len
                    if cursor > now and not any(_overlaps(cursor, slot_end, b0, b1) for b0, b1 in booked):
                        free.append(cursor.astimezone(UTC))
                    cursor += step
        day += timedelta(days=1)

    return free
