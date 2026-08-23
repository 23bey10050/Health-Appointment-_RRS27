import uuid
from datetime import UTC, datetime

import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import hash_password
from app.models.doctor import DoctorProfile
from app.models.emergency import EmergencyQueueEntry
from app.models.enums import UserRole
from app.models.hospital import Hospital
from app.models.notification import EmailOutbox
from app.models.user import User
from app.models.voice import VoiceSession
from app.safety.escalation import record_emergency
from app.safety.red_flags import RedFlagHit

pytestmark = pytest.mark.asyncio


async def _make_doctor(db_session: AsyncSession, *, accepts_emergency: bool, hospital_id: uuid.UUID | None) -> uuid.UUID:
    user = User(
        email=f"doc-{uuid.uuid4().hex[:10]}@test.example",
        full_name="Dr. Oncall",
        password_hash=hash_password("irrelevant"),
        role=UserRole.doctor,
    )
    db_session.add(user)
    await db_session.flush()
    db_session.add(
        DoctorProfile(
            user_id=user.id,
            hospital_id=hospital_id,
            specialisation="General Medicine",
            accepts_emergency=accepts_emergency,
        )
    )
    await db_session.commit()
    return user.id


@pytest_asyncio.fixture
async def voice_session(db_session: AsyncSession, seeded_patient: uuid.UUID) -> uuid.UUID:
    vs = VoiceSession(patient_id=seeded_patient, consent_given_at=datetime.now(UTC), consent_version="v1")
    db_session.add(vs)
    await db_session.commit()
    return vs.id


def _hit() -> RedFlagHit:
    return RedFlagHit(id="cardiac_acs", severity="critical", category="cardiac", matched_text="chest pain", script_id="emergency_cardiac")


async def test_pages_any_accepting_doctor_when_hospital_unknown(
    db_session: AsyncSession, seeded_patient: uuid.UUID, voice_session: uuid.UUID
):
    """The common case: a red flag fires on turn one, before any hospital has been
    discussed. hospital_id is None here -- paging must still find someone rather
    than silently notifying no one (this was a real, previously-unnoticed gap)."""
    oncall = await _make_doctor(db_session, accepts_emergency=True, hospital_id=None)

    entry = await record_emergency(
        db_session, hit=_hit(), voice_session_id=voice_session, patient_id=seeded_patient,
        hospital_id=None, transcript_excerpt="I have crushing chest pain",
    )

    assert entry.oncall_doctor_id == oncall
    emails = (await db_session.scalars(select(EmailOutbox).where(EmailOutbox.to_email.like("doc-%")))).all()
    assert len(emails) == 1
    assert emails[0].template == "emergency_alert_doctor"


async def test_scopes_to_hospital_when_known(db_session: AsyncSession, seeded_patient: uuid.UUID, voice_session: uuid.UUID):
    """Regression guard: once a hospital *is* known, paging must stay scoped to it,
    not fall back to notifying an unrelated hospital's on-call doctor."""
    h1 = Hospital(name="Hospital A")
    h2 = Hospital(name="Hospital B")
    db_session.add_all([h1, h2])
    await db_session.commit()

    wrong_hospital_doctor = await _make_doctor(db_session, accepts_emergency=True, hospital_id=h2.id)
    right_hospital_doctor = await _make_doctor(db_session, accepts_emergency=True, hospital_id=h1.id)

    entry = await record_emergency(
        db_session, hit=_hit(), voice_session_id=voice_session, patient_id=seeded_patient,
        hospital_id=h1.id, transcript_excerpt="chest pain",
    )

    assert entry.oncall_doctor_id == right_hospital_doctor
    assert entry.oncall_doctor_id != wrong_hospital_doctor


async def test_creates_case_even_with_no_accepting_doctor_anywhere(
    db_session: AsyncSession, seeded_patient: uuid.UUID, voice_session: uuid.UUID
):
    """No doctor accepts emergencies at all -- the case must still be recorded
    (visible in the admin queue) even though nobody could be paged."""
    entry = await record_emergency(
        db_session, hit=_hit(), voice_session_id=voice_session, patient_id=seeded_patient,
        hospital_id=None, transcript_excerpt="chest pain",
    )
    assert entry.id is not None
    assert entry.oncall_doctor_id is None

    persisted = await db_session.get(EmergencyQueueEntry, entry.id)
    assert persisted is not None
