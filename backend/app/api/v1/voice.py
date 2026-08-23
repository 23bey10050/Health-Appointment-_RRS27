import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.rate_limit import rate_limit
from app.core.security import CurrentUser, create_voice_ticket, require_role
from app.db.session import get_session
from app.models.enums import UserRole
from app.models.voice import VoiceSession, VoiceTurn
from app.services.audit import record_audit

router = APIRouter(prefix="/voice", tags=["voice"])


@router.post(
    "/sessions",
    status_code=status.HTTP_201_CREATED,
    # Each session spins up an STT/TTS/LLM pipeline -- cheap to request, expensive
    # to serve. 20/min per IP comfortably covers React StrictMode's dev-mode
    # double-fetch (see useVoiceSocket.ts) plus normal reconnects.
    dependencies=[Depends(rate_limit("voice_session_create", limit=20, window_seconds=60))],
)
async def create_voice_session(
    current: CurrentUser = Depends(require_role(UserRole.patient)),
) -> dict:
    """Section 14: returns session_id + a single-use WS ticket. The VoiceSession
    row itself isn't inserted until the `session_start` WS message arrives with
    consent_version -- SAFETY-6 requires consent to exist before any row does."""
    session_id = uuid.uuid4()
    ticket = create_voice_ticket(session_id=session_id, patient_id=current.id)
    return {"session_id": str(session_id), "ticket": ticket}


@router.get("/sessions/{voice_session_id}/transcript")
async def get_transcript(
    voice_session_id: uuid.UUID,
    current: CurrentUser = Depends(require_role(UserRole.patient, UserRole.doctor, UserRole.admin)),
    session: AsyncSession = Depends(get_session),
) -> dict:
    voice_session = await session.get(VoiceSession, voice_session_id)
    if voice_session is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Voice session not found")
    if current.role == UserRole.patient and voice_session.patient_id != current.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Not your session")
    # Doctors see transcripts for their own patients only -- approximated here via
    # a shared appointment; admins see all.
    if current.role == UserRole.doctor:
        from app.models.appointment import Appointment

        owns_patient = False
        if voice_session.appointment_id:
            appt = await session.get(Appointment, voice_session.appointment_id)
            owns_patient = appt is not None and appt.doctor_id == current.id
        if not owns_patient:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Not your patient")

    if current.role in (UserRole.doctor, UserRole.admin):
        # A transcript is patient-generated free speech, often about symptoms --
        # third-party reads of it are exactly what an audit trail is for.
        await record_audit(
            session, actor_id=current.id, actor_role=current.role, action="voice_transcript_read",
            entity_type="voice_session", entity_id=voice_session_id,
        )

    turns = (
        await session.scalars(
            select(VoiceTurn).where(VoiceTurn.session_id == voice_session_id).order_by(VoiceTurn.turn_index)
        )
    ).all()
    return {
        "session_id": str(voice_session_id),
        "outcome": voice_session.outcome,
        "emergency_triggered": voice_session.emergency_triggered,
        "turns": [
            {"turn_index": t.turn_index, "speaker": t.speaker, "transcript": t.transcript, "created_at": t.created_at.isoformat()}
            for t in turns
        ],
    }
