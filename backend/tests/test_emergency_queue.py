import uuid

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.emergency import acknowledge, list_emergency_queue, resolve
from app.core.security import CurrentUser
from app.models.doctor import DoctorProfile
from app.models.emergency import EmergencyQueueEntry, EmergencyQueueStatus
from app.models.enums import UserRole
from app.models.hospital import Hospital

pytestmark = pytest.mark.asyncio


@pytest_asyncio.fixture
async def hospital(db_session: AsyncSession) -> uuid.UUID:
    h = Hospital(name="Test Hospital", has_emergency_dept=True)
    db_session.add(h)
    await db_session.commit()
    return h.id


@pytest_asyncio.fixture
async def doctor_at_hospital(db_session: AsyncSession, seeded_doctor: uuid.UUID, hospital: uuid.UUID) -> uuid.UUID:
    profile = await db_session.get(DoctorProfile, seeded_doctor)
    profile.hospital_id = hospital
    await db_session.commit()
    return seeded_doctor


@pytest_asyncio.fixture
async def emergency_entry(
    db_session: AsyncSession, seeded_patient: uuid.UUID, hospital: uuid.UUID, doctor_at_hospital: uuid.UUID
) -> uuid.UUID:
    entry = EmergencyQueueEntry(
        patient_id=seeded_patient,
        hospital_id=hospital,
        category="cardiac",
        severity="critical",
        summary='Red flag \'cardiac_acs\' matched: "chest pain"',
        oncall_doctor_id=doctor_at_hospital,
    )
    db_session.add(entry)
    await db_session.commit()
    return entry.id


async def test_doctor_sees_only_own_hospital_entries(
    db_session: AsyncSession, doctor_at_hospital: uuid.UUID, emergency_entry: uuid.UUID, seeded_patient: uuid.UUID
):
    current = CurrentUser(id=doctor_at_hospital, role=UserRole.doctor)
    result = await list_emergency_queue(current=current, session=db_session)
    assert len(result) == 1
    assert result[0].id == emergency_entry
    assert result[0].category == "cardiac"
    assert result[0].status == EmergencyQueueStatus.active
    assert result[0].patient_id == seeded_patient


async def test_doctor_sees_own_paged_case_even_when_hospital_unknown(
    db_session: AsyncSession, doctor_at_hospital: uuid.UUID, seeded_patient: uuid.UUID
):
    """escalation.record_emergency can page a doctor onto a case whose hospital_id
    is None (the conversation never resolved a hospital); that doctor must still
    see and be able to act on the case they were personally paged for."""
    entry = EmergencyQueueEntry(
        patient_id=seeded_patient,
        hospital_id=None,
        category="cardiac",
        severity="critical",
        summary="chest pain",
        oncall_doctor_id=doctor_at_hospital,
    )
    db_session.add(entry)
    await db_session.commit()

    current = CurrentUser(id=doctor_at_hospital, role=UserRole.doctor)
    result = await list_emergency_queue(current=current, session=db_session)
    assert [r.id for r in result] == [entry.id]

    acked = await acknowledge(entry.id, current=current, session=db_session)
    assert acked.status == EmergencyQueueStatus.acknowledged


async def test_doctor_at_different_hospital_sees_nothing(
    db_session: AsyncSession, seeded_doctor: uuid.UUID, emergency_entry: uuid.UUID
):
    # seeded_doctor here has no hospital_id set at all (a second, unaffiliated doctor).
    other_doctor = CurrentUser(id=uuid.uuid4(), role=UserRole.doctor)
    result = await list_emergency_queue(current=other_doctor, session=db_session)
    assert result == []


async def test_admin_sees_all_hospitals(db_session: AsyncSession, emergency_entry: uuid.UUID):
    admin = CurrentUser(id=uuid.uuid4(), role=UserRole.admin)
    result = await list_emergency_queue(current=admin, session=db_session)
    assert len(result) == 1


async def test_acknowledge_then_resolve_gate(
    db_session: AsyncSession, doctor_at_hospital: uuid.UUID, emergency_entry: uuid.UUID
):
    current = CurrentUser(id=doctor_at_hospital, role=UserRole.doctor)

    acked = await acknowledge(emergency_entry, current=current, session=db_session)
    assert acked.status == EmergencyQueueStatus.acknowledged
    assert acked.acknowledged_at is not None

    resolved = await resolve(emergency_entry, current=current, session=db_session)
    assert resolved.status == EmergencyQueueStatus.resolved
    assert resolved.resolved_at is not None
    # acknowledged_at was set by the earlier call and must not be clobbered.
    assert resolved.acknowledged_at == acked.acknowledged_at


async def test_resolve_without_prior_acknowledge_backfills_acknowledged_at(
    db_session: AsyncSession, doctor_at_hospital: uuid.UUID, emergency_entry: uuid.UUID
):
    current = CurrentUser(id=doctor_at_hospital, role=UserRole.doctor)
    resolved = await resolve(emergency_entry, current=current, session=db_session)
    assert resolved.status == EmergencyQueueStatus.resolved
    assert resolved.acknowledged_at is not None
    assert resolved.resolved_at is not None


async def test_doctor_cannot_acknowledge_other_hospitals_case(
    db_session: AsyncSession, emergency_entry: uuid.UUID
):
    from fastapi import HTTPException

    other_doctor = CurrentUser(id=uuid.uuid4(), role=UserRole.doctor)
    with pytest.raises(HTTPException) as exc_info:
        await acknowledge(emergency_entry, current=other_doctor, session=db_session)
    assert exc_info.value.status_code == 403
