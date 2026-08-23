"""IMPLEMENTATION.md section 7.2 -- the acceptance gate for Phase 1.

50 concurrent hold_slot coroutines race for the same slot. Exactly one must
succeed; the other 49 must raise SlotUnavailableError cleanly (no crashes, no
partial rows). The exclusion constraint (migration 0001) is what actually
guarantees this -- this test exists to prove hold_slot's error handling around
it is correct, not to re-derive the constraint's own correctness.
"""

import asyncio
import uuid
from datetime import timedelta

import pytest
from sqlalchemy import func, select

from app.core.errors import SlotUnavailableError
from app.models.appointment import Appointment
from app.models.enums import AppointmentStatus
from app.services.booking import hold_slot
from tests.conftest import future_slot_start

CONCURRENCY = 50


@pytest.mark.asyncio
async def test_fifty_concurrent_holds_exactly_one_succeeds(test_sessionmaker, seeded_doctor, seeded_patient):
    start_at = future_slot_start(days_ahead=1, hour=10)

    async def attempt() -> tuple[str, uuid.UUID | None]:
        async with test_sessionmaker() as session:
            try:
                appt = await hold_slot(session, seeded_doctor, seeded_patient, start_at, 20)
                return "ok", appt.id
            except SlotUnavailableError:
                return "unavailable", None

    results = await asyncio.gather(*(attempt() for _ in range(CONCURRENCY)))

    successes = [r for r in results if r[0] == "ok"]
    failures = [r for r in results if r[0] == "unavailable"]

    assert len(successes) == 1, f"expected exactly 1 success, got {len(successes)}: {results}"
    assert len(failures) == CONCURRENCY - 1

    # And the DB agrees: exactly one held/confirmed row for this doctor+slot.
    async with test_sessionmaker() as session:
        count = await session.scalar(
            select(func.count())
            .select_from(Appointment)
            .where(
                Appointment.doctor_id == seeded_doctor,
                Appointment.start_at == start_at,
                Appointment.status.in_([AppointmentStatus.held, AppointmentStatus.confirmed]),
            )
        )
        assert count == 1


@pytest.mark.asyncio
async def test_different_slots_all_succeed(test_sessionmaker, seeded_doctor, seeded_patient):
    """Sanity check: the exclusion constraint blocks overlap, not concurrency itself."""

    async def attempt(offset_min: int):
        start_at = future_slot_start(days_ahead=1, hour=10) + timedelta(minutes=offset_min)
        async with test_sessionmaker() as session:
            return await hold_slot(session, seeded_doctor, seeded_patient, start_at, 20)

    # Non-overlapping 20-minute slots, back to back.
    results = await asyncio.gather(*(attempt(i * 20) for i in range(10)))
    assert len({r.id for r in results}) == 10


@pytest.mark.asyncio
async def test_hold_slot_rejects_outside_working_hours(test_sessionmaker, seeded_doctor, seeded_patient):
    late_night = future_slot_start(days_ahead=1, hour=3)  # doctor works 06:00-22:00
    async with test_sessionmaker() as session:
        with pytest.raises(SlotUnavailableError):
            await hold_slot(session, seeded_doctor, seeded_patient, late_night, 20)
