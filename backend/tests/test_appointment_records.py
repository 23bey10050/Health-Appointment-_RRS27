import pytest
from fastapi import HTTPException

from app.api.v1.appointments import get_encounter_for_appointment, get_post_visit_summary
from app.core.security import CurrentUser
from app.models.encounter import AISummary
from app.models.enums import SummaryKind, SummaryState, UserRole
from app.services.booking import confirm_booking, hold_slot
from tests.conftest import future_slot_start

pytestmark = pytest.mark.asyncio


@pytest.fixture
def slot():
    return future_slot_start(days_ahead=3)


async def _confirmed_appointment(db_session, seeded_doctor, seeded_patient, slot):
    held = await hold_slot(db_session, seeded_doctor, seeded_patient, slot, 20)
    return await confirm_booking(db_session, held.id, seeded_patient)


async def test_encounter_lookup_404_before_submission(db_session, seeded_doctor, seeded_patient, slot):
    appt = await _confirmed_appointment(db_session, seeded_doctor, seeded_patient, slot)
    doctor = CurrentUser(id=seeded_doctor, role=UserRole.doctor)
    with pytest.raises(HTTPException) as exc_info:
        await get_encounter_for_appointment(appt.id, current=doctor, session=db_session)
    assert exc_info.value.status_code == 404


async def test_patient_cannot_see_unapproved_post_visit_summary(db_session, seeded_doctor, seeded_patient, slot):
    appt = await _confirmed_appointment(db_session, seeded_doctor, seeded_patient, slot)
    db_session.add(
        AISummary(kind=SummaryKind.post_visit, appointment_id=appt.id, state=SummaryState.draft, content={"x": 1})
    )
    await db_session.commit()

    patient = CurrentUser(id=seeded_patient, role=UserRole.patient)
    with pytest.raises(HTTPException) as exc_info:
        await get_post_visit_summary(appt.id, current=patient, session=db_session)
    assert exc_info.value.status_code == 404

    # But the doctor who owns it can still see the draft.
    doctor = CurrentUser(id=seeded_doctor, role=UserRole.doctor)
    result = await get_post_visit_summary(appt.id, current=doctor, session=db_session)
    assert result.state == SummaryState.draft


async def test_patient_sees_approved_post_visit_summary(db_session, seeded_doctor, seeded_patient, slot):
    appt = await _confirmed_appointment(db_session, seeded_doctor, seeded_patient, slot)
    db_session.add(
        AISummary(kind=SummaryKind.post_visit, appointment_id=appt.id, state=SummaryState.approved, content={"x": 1})
    )
    await db_session.commit()

    patient = CurrentUser(id=seeded_patient, role=UserRole.patient)
    result = await get_post_visit_summary(appt.id, current=patient, session=db_session)
    assert result.state == SummaryState.approved
