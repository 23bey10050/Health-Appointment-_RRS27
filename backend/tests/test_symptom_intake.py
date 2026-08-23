"""The symptom form a patient fills in before confirming a booking.

Covers the web booking path specifically. The voice agent gathers the same
information conversationally and stores a transcript instead, so these tests are
about the channel that previously sent nothing at all.
"""

import pytest

from app.schemas.appointment import SymptomIntake
from app.services.booking import confirm_booking, hold_slot
from tests.conftest import future_slot_start


@pytest.fixture
def slot():
    return future_slot_start(days_ahead=4)


def test_reason_text_includes_every_answered_field():
    intake = SymptomIntake(
        symptoms="Chest tightness climbing stairs",
        duration="5 days",
        severity=6,
        existing_conditions="hypertension",
        current_medications="amlodipine 5mg",
        allergies="penicillin",
    )
    text = intake.to_reason_text()
    for expected in ("Chest tightness", "5 days", "6", "hypertension", "amlodipine", "penicillin"):
        assert expected in text


def test_reason_text_omits_blank_optional_fields():
    text = SymptomIntake(symptoms="Sore throat").to_reason_text()
    assert text == "Symptoms: Sore throat"
    assert "Duration" not in text
    assert "Severity" not in text


def test_severity_outside_one_to_ten_is_rejected():
    with pytest.raises(ValueError):
        SymptomIntake(symptoms="headache", severity=11)


def test_empty_symptoms_are_rejected():
    with pytest.raises(ValueError):
        SymptomIntake(symptoms="")


@pytest.mark.asyncio
async def test_confirm_persists_intake_to_reason_text(db_session, seeded_doctor, seeded_patient, slot):
    held = await hold_slot(db_session, seeded_doctor, seeded_patient, slot, 20)
    intake = SymptomIntake(symptoms="Fever and dry cough", duration="3 days", severity=4)

    appt = await confirm_booking(db_session, held.id, seeded_patient, reason_text=intake.to_reason_text())

    assert appt.reason_text is not None
    assert "Fever and dry cough" in appt.reason_text
    assert "3 days" in appt.reason_text


@pytest.mark.asyncio
async def test_confirm_without_intake_still_works(db_session, seeded_doctor, seeded_patient, slot):
    """The voice path passes no reason_text -- it supplies a transcript instead."""
    held = await hold_slot(db_session, seeded_doctor, seeded_patient, slot, 20)
    appt = await confirm_booking(db_session, held.id, seeded_patient)
    assert appt.reason_text is None


@pytest.mark.asyncio
async def test_reconfirming_does_not_wipe_stored_symptoms(db_session, seeded_doctor, seeded_patient, slot):
    """Confirm is idempotent, and a retry without a body must not blank the form."""
    held = await hold_slot(db_session, seeded_doctor, seeded_patient, slot, 20)
    await confirm_booking(db_session, held.id, seeded_patient, reason_text="Symptoms: migraine")

    again = await confirm_booking(db_session, held.id, seeded_patient)
    assert again.reason_text == "Symptoms: migraine"
