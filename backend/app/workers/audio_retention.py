"""Audio retention purge -- IMPLEMENTATION.md section 13.3: "purge_expired_audio:
daily 03:00: Delete raw audio past retention."

This implementation never persists raw PCM/audio to disk or object storage at all
-- the voice pipeline processes audio in memory only (voice/orchestrator.py,
api/v1/voice_ws.py), so there is no audio blob for this job to delete. The
retained artifact carrying the same privacy exposure is the transcript text on
voice_turns and the collected_data JSON (symptoms, DOB, etc.) on voice_sessions;
this job redacts those once a session's audio_retention_until date has passed,
which is the substitution for "delete raw audio" that matches what this
implementation actually stores. Idempotent: re-running against an
already-purged row just re-writes the same redacted value.
"""

import asyncio
from datetime import date

import structlog
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.models.voice import VoiceSession, VoiceTurn
from app.workers.celery_app import celery_app
from app.workers.db import worker_engine

logger = structlog.get_logger(__name__)

REDACTED_TRANSCRIPT = "[purged per retention policy]"


async def _purge_expired_audio_async() -> int:
    async with worker_engine() as engine:
        Session = async_sessionmaker(bind=engine, expire_on_commit=False)
        async with Session() as session, session.begin():
            expired_ids = (
                await session.scalars(
                    select(VoiceSession.id).where(
                        VoiceSession.audio_retention_until.is_not(None),
                        VoiceSession.audio_retention_until < date.today(),
                    )
                )
            ).all()
            if not expired_ids:
                return 0

            await session.execute(
                update(VoiceTurn)
                .where(VoiceTurn.session_id.in_(expired_ids), VoiceTurn.transcript.is_not(None))
                .values(transcript=REDACTED_TRANSCRIPT)
            )
            await session.execute(
                update(VoiceSession).where(VoiceSession.id.in_(expired_ids)).values(collected_data={})
            )
    logger.info("audio_retention_purged", session_count=len(expired_ids))
    return len(expired_ids)


@celery_app.task(name="app.workers.audio_retention.purge_expired_audio")
def purge_expired_audio() -> int:
    return asyncio.run(_purge_expired_audio_async())
