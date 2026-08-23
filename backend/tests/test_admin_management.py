import uuid

import pytest

from app.api.v1.admin import (
    confirm_leave,
    create_doctor,
    create_hospital,
    get_admin_doctor,
    list_admin_doctors,
    preview_leave,
    replace_working_hours,
    update_doctor,
    update_hospital,
)
from app.api.v1.calendar_oauth import status_endpoint
from app.core.security import CurrentUser
from app.models.enums import UserRole
from app.schemas.admin import DoctorCreate, DoctorUpdate, HospitalCreate, HospitalUpdate, WorkingHoursIn
from app.schemas.leave import LeaveConfirmRequest, LeaveRequest

pytestmark = pytest.mark.asyncio


async def test_admin_creates_and_updates_doctor(db_session, seeded_admin):
    admin = CurrentUser(id=seeded_admin, role=UserRole.admin)

    created = await create_doctor(
        DoctorCreate(
            email="new.doc@test.example",
            full_name="Dr. New",
            password="irrelevant123",
            specialisation="Cardiology",
            accepts_emergency=True,
            working_hours=[WorkingHoursIn(weekday=0, start_time="09:00", end_time="17:00")],
        ),
        current=admin,
        session=db_session,
    )
    assert created.full_name == "Dr. New"
    assert created.specialisation == "Cardiology"
    assert len(created.working_hours) == 1

    listed = await list_admin_doctors(current=admin, session=db_session)
    assert any(d.user_id == created.user_id for d in listed)

    updated = await update_doctor(
        created.user_id, DoctorUpdate(specialisation="General Medicine", is_accepting=False),
        current=admin, session=db_session,
    )
    assert updated.specialisation == "General Medicine"
    assert updated.is_accepting is False
    assert updated.full_name == "Dr. New"  # untouched fields survive a partial update

    fetched = await get_admin_doctor(created.user_id, current=admin, session=db_session)
    assert fetched.specialisation == "General Medicine"


async def test_duplicate_email_rejected(db_session, seeded_admin, seeded_patient):
    from app.models.user import User

    admin = CurrentUser(id=seeded_admin, role=UserRole.admin)
    existing_email = (await db_session.get(User, seeded_patient)).email

    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc_info:
        await create_doctor(
            DoctorCreate(email=existing_email, full_name="Dupe", password="x", specialisation="ENT"),
            current=admin, session=db_session,
        )
    assert exc_info.value.status_code == 409


async def test_replace_working_hours(db_session, seeded_admin, seeded_doctor):
    admin = CurrentUser(id=seeded_admin, role=UserRole.admin)
    result = await replace_working_hours(
        seeded_doctor,
        [WorkingHoursIn(weekday=1, start_time="10:00", end_time="14:00")],
        current=admin, session=db_session,
    )
    assert len(result) == 1
    assert result[0].weekday == 1

    fetched = await get_admin_doctor(seeded_doctor, current=admin, session=db_session)
    assert len(fetched.working_hours) == 1
    assert fetched.working_hours[0].weekday == 1


async def test_hospital_create_and_update(db_session, seeded_admin):
    admin = CurrentUser(id=seeded_admin, role=UserRole.admin)
    hospital = await create_hospital(
        HospitalCreate(name="Test General", city="Testville"), current=admin, session=db_session
    )
    assert hospital.name == "Test General"

    updated = await update_hospital(
        hospital.id, HospitalUpdate(has_emergency_dept=True), current=admin, session=db_session
    )
    assert updated.has_emergency_dept is True
    assert updated.name == "Test General"


async def test_doctor_leave_self_service(db_session, seeded_doctor):
    doctor = CurrentUser(id=seeded_doctor, role=UserRole.doctor)
    from tests.conftest import future_slot_start

    start = future_slot_start(days_ahead=10).date()
    preview = await preview_leave(
        seeded_doctor, LeaveRequest(start_date=start, end_date=start), current=doctor, session=db_session
    )
    assert preview.doctor_id == seeded_doctor

    confirmed = await confirm_leave(
        seeded_doctor, LeaveConfirmRequest(start_date=start, end_date=start), current=doctor, session=db_session
    )
    assert confirmed.doctor_id == seeded_doctor


async def test_doctor_cannot_manage_another_doctors_leave(db_session, seeded_doctor):
    other_doctor = CurrentUser(id=uuid.uuid4(), role=UserRole.doctor)
    from fastapi import HTTPException

    from tests.conftest import future_slot_start

    start = future_slot_start(days_ahead=10).date()
    with pytest.raises(HTTPException) as exc_info:
        await preview_leave(
            seeded_doctor, LeaveRequest(start_date=start, end_date=start), current=other_doctor, session=db_session
        )
    assert exc_info.value.status_code == 403


async def test_calendar_status_disconnected_by_default(db_session, seeded_patient):
    current = CurrentUser(id=seeded_patient, role=UserRole.patient)
    result = await status_endpoint(current=current, session=db_session)
    assert result == {"connected": False, "connected_at": None}


async def test_admin_health_smoke(db_session, seeded_admin):
    from app.api.v1.admin import admin_health

    admin = CurrentUser(id=seeded_admin, role=UserRole.admin)
    result = await admin_health(current=admin, session=db_session)
    assert isinstance(result.outbox_backlog, dict)
    assert result.voice_sessions_total >= 0
    assert 0.0 <= result.red_flag_fire_rate <= 1.0
    assert isinstance(result.llm_provider_status, list)
    assert len(result.llm_provider_status) > 0  # real router state, not empty/faked
    assert {"tier", "provider", "model", "circuit_state"} <= result.llm_provider_status[0].keys()
