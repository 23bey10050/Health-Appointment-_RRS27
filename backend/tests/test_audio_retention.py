"""IMPLEMENTATION.md section 13.3 purge_expired_audio -- see the module docstring
in app/workers/audio_retention.py for why this redacts transcript/collected_data
rather than deleting audio files (none are ever persisted)."""

from datetime import UTC, date, datetime, timedelta

import pytest
from sqlalchemy import select

from app.models.voice import VoiceSession, VoiceTurn
from app.workers.audio_retention import REDACTED_TRANSCRIPT, _purge_expired_audio_async

pytestmark = pytest.mark.asyncio


async def test_purges_expired_sessions_only(db_session, test_sessionmaker, seeded_patient):
    expired = VoiceSession(
        patient_id=seeded_patient,
        consent_given_at=datetime.now(UTC),
        consent_version="v1",
        audio_retention_until=date.today() - timedelta(days=1),
        collected_data={"chief_complaint": "chest pain"},
    )
    not_yet_expired = VoiceSession(
        patient_id=seeded_patient,
        consent_given_at=datetime.now(UTC),
        consent_version="v1",
        audio_retention_until=date.today() + timedelta(days=6),
        collected_data={"chief_complaint": "headache"},
    )
    never_ended = VoiceSession(
        patient_id=seeded_patient, consent_given_at=datetime.now(UTC), consent_version="v1",
    )
    db_session.add_all([expired, not_yet_expired, never_ended])
    await db_session.flush()

    db_session.add_all([
        VoiceTurn(session_id=expired.id, turn_index=0, speaker="patient", transcript="I have chest pain"),
        VoiceTurn(session_id=not_yet_expired.id, turn_index=0, speaker="patient", transcript="my head hurts"),
    ])
    await db_session.commit()

    count = await _purge_expired_audio_async()
    assert count == 1

    async with test_sessionmaker() as session:
        expired_row = await session.get(VoiceSession, expired.id)
        assert expired_row.collected_data == {}
        expired_turn = await session.scalar(select(VoiceTurn).where(VoiceTurn.session_id == expired.id))
        assert expired_turn.transcript == REDACTED_TRANSCRIPT

        untouched_row = await session.get(VoiceSession, not_yet_expired.id)
        assert untouched_row.collected_data == {"chief_complaint": "headache"}
        untouched_turn = await session.scalar(select(VoiceTurn).where(VoiceTurn.session_id == not_yet_expired.id))
        assert untouched_turn.transcript == "my head hurts"


async def test_no_expired_sessions_is_a_no_op(db_session):
    count = await _purge_expired_audio_async()
    assert count == 0


async def test_purge_is_idempotent(db_session, seeded_patient):
    expired = VoiceSession(
        patient_id=seeded_patient,
        consent_given_at=datetime.now(UTC),
        consent_version="v1",
        audio_retention_until=date.today() - timedelta(days=1),
    )
    db_session.add(expired)
    await db_session.commit()

    first = await _purge_expired_audio_async()
    second = await _purge_expired_audio_async()
    assert first == 1
    assert second == 1  # still matches the date filter; re-redacting is harmless
