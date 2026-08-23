"""WebSocket endpoint -- IMPLEMENTATION.md section 10.1 protocol, section 14
auth: "Authenticate the WebSocket with a short-lived (60s) single-use ticket
issued by POST /voice/sessions. Do not put JWTs in query strings." (The ticket
itself still travels in the query string -- it's a purpose-built single-use
ticket, not a reusable JWT, which is the actual thing that instruction guards
against.)

The connection is JSON-only in both directions. STT runs in the browser (Web
Speech API) and sends final text on `speech_end`; TTS is the browser's
speechSynthesis, driven by `agent_text`. The PCM accumulation this module used to
do is gone along with faster-whisper and Piper.
"""

import json
import uuid
from datetime import UTC, datetime

import structlog
from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect

from app.config import get_settings
from app.core.security import TOKEN_TYPE_VOICE_TICKET, decode_token
from app.db.session import SessionLocal
from app.deps import get_redis_client
from app.models.voice import VoiceSession
from app.voice.orchestrator import VoiceOrchestrator
from app.voice.protocol import parse_client_message

logger = structlog.get_logger(__name__)
router = APIRouter()
settings = get_settings()


class _WebSocketTransport:
    def __init__(self, websocket: WebSocket):
        self._ws = websocket

    async def send_json(self, data: dict) -> None:
        await self._ws.send_json(data)

    async def send_bytes(self, data: bytes) -> None:
        await self._ws.send_bytes(data)


async def _authenticate(ticket: str) -> uuid.UUID | None:
    """Returns patient_id (may be None for an anonymous caller) if the ticket is
    valid and unused; raises ValueError otherwise. Single-use is enforced via a
    Redis SETNX keyed on the token's jti, TTL'd past the ticket's own expiry."""
    payload = decode_token(ticket)  # raises HTTPException (caught by caller) if expired/malformed
    if payload.token_type != TOKEN_TYPE_VOICE_TICKET:
        raise ValueError("Not a voice ticket")

    redis = get_redis_client()
    first_use = await redis.set(f"voice_ticket_used:{payload.jti}", "1", nx=True, ex=90)
    if not first_use:
        raise ValueError("Ticket already used")

    patient_id_raw = payload.extra.get("patient_id")
    return uuid.UUID(patient_id_raw) if patient_id_raw else None


@router.websocket("/ws/voice/{session_id}")
async def voice_ws(websocket: WebSocket, session_id: uuid.UUID, ticket: str = Query(...)):
    try:
        patient_id = await _authenticate(ticket)
    except Exception as e:
        logger.warning("voice_ws_auth_failed", session_id=str(session_id), error=str(e))
        await websocket.close(code=4401)
        return

    await websocket.accept()
    redis = get_redis_client()
    transport = _WebSocketTransport(websocket)
    orchestrator: VoiceOrchestrator | None = None
    hospital_id: uuid.UUID | None = None

    try:
        while True:
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                break

            # JSON-only in both directions now that STT and TTS both run in the
            # browser. Any binary frame is a stale client -- ignore rather than
            # crash, so an old tab open across a deploy degrades quietly.
            if message.get("bytes") is not None:
                continue

            raw_text = message.get("text")
            if raw_text is None:
                continue

            try:
                parsed = parse_client_message(json.loads(raw_text))
            except (ValueError, TypeError) as e:
                await transport.send_json({"type": "error", "code": "bad_message", "recoverable": True, "message": str(e)})
                continue

            if parsed.type == "session_start":
                async with SessionLocal() as db:
                    voice_session = VoiceSession(
                        id=session_id,
                        patient_id=patient_id,
                        consent_given_at=datetime.now(UTC),
                        consent_version=parsed.consent_version,
                    )
                    db.add(voice_session)
                    await db.commit()

                orchestrator = VoiceOrchestrator(
                    voice_session_id=session_id, patient_id=patient_id, hospital_id=hospital_id,
                    transport=transport, session_factory=SessionLocal, redis=redis,
                )
                await orchestrator.handle_session_start()

            elif orchestrator is None:
                await transport.send_json(
                    {"type": "error", "code": "no_session", "recoverable": True, "message": "Send session_start first."}
                )

            elif parsed.type == "speech_start":
                pass  # nothing to buffer: the browser holds the audio and sends text

            elif parsed.type == "speech_end":
                await orchestrator.handle_speech_end(parsed.text, parsed.confidence)

            elif parsed.type == "barge_in":
                await orchestrator.handle_barge_in()

            elif parsed.type == "text_input":
                await orchestrator.handle_text_input(parsed.text)

            elif parsed.type == "session_end":
                await orchestrator.handle_session_end(parsed.reason)
                break

    except WebSocketDisconnect:
        if orchestrator is not None:
            await orchestrator.handle_session_end("connection_dropped")
    except Exception as e:  # noqa: BLE001 -- a live voice session must degrade, not crash silently
        logger.error("voice_ws_error", session_id=str(session_id), error=str(e))
        try:
            await transport.send_json({"type": "error", "code": "internal_error", "recoverable": False, "message": "Something went wrong."})
        except Exception:
            pass
        if orchestrator is not None:
            await orchestrator.handle_session_end("error")
