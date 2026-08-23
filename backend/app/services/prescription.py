"""Prescription -> reminder expansion -- IMPLEMENTATION.md section 13.3.

Maps a frequency code to clinic-default times of day, expands across duration_days
in the patient's timezone, and inserts medication_reminders rows. The table's
UNIQUE (prescription_id, scheduled_at, channel) constraint is what actually makes
this idempotent (ON CONFLICT DO NOTHING) -- re-running expansion for the same
prescription, e.g. after a retry, never double-books a reminder.
"""

import uuid
from datetime import date, datetime, time, timedelta

from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.services.availability import CLINIC_TZ

FREQUENCY_TIMES: dict[str, list[time]] = {
    "OD": [time(9, 0)],
    "BD": [time(9, 0), time(21, 0)],
    "TDS": [time(8, 0), time(14, 0), time(20, 0)],
    "QID": [time(8, 0), time(12, 0), time(16, 0), time(20, 0)],
    "HS": [time(22, 0)],
    "SOS": [],  # as-needed -- no scheduled reminders
    "Q6H": [time(6, 0), time(12, 0), time(18, 0), time(0, 0)],
}


async def expand_reminders(
    session: AsyncSession,
    *,
    prescription_id: uuid.UUID,
    patient_id: uuid.UUID,
    frequency_code: str,
    start_date: date,
    duration_days: int,
    now: datetime | None = None,
) -> int:
    from app.models.notification import MedicationReminder

    times = FREQUENCY_TIMES.get(frequency_code.upper(), [])
    if not times:
        return 0

    now = now or datetime.now(CLINIC_TZ)
    rows = []
    for day_offset in range(duration_days):
        day = start_date + timedelta(days=day_offset)
        for t in times:
            scheduled_local = datetime.combine(day, t, tzinfo=CLINIC_TZ)
            if scheduled_local <= now:
                continue  # never schedule a reminder in the past
            rows.append(
                {
                    "prescription_id": prescription_id,
                    "patient_id": patient_id,
                    "scheduled_at": scheduled_local.astimezone(CLINIC_TZ),
                    "channel": "email",
                }
            )

    if not rows:
        return 0

    stmt = (
        pg_insert(MedicationReminder)
        .values(rows)
        .on_conflict_do_nothing(index_elements=["prescription_id", "scheduled_at", "channel"])
    )
    await session.execute(stmt)
    return len(rows)
