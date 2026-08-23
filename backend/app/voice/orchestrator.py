"""Voice session state machine -- IMPLEMENTATION.md section 10.2.

    IDLE --session_start--> GREETING --> LISTENING
    LISTENING --speech_end--> TRANSCRIBING
    TRANSCRIBING --[red flag]--> EMERGENCY  (terminal for routine flow)
                 --> THINKING
    THINKING --> (RAG || LLM) --> TOOL_CALLING? --> SPEAKING
    SPEAKING --audio_end--> LISTENING
             --barge_in--> (abort TTS, flush buffer) --> LISTENING
    ANY --session_end--> CLOSING --> persist turns, metrics, trigger summary

One instance per session. `transport` is a thin Protocol (send_json/send_bytes)
so this is testable without a live WebSocket -- api/v1/voice_ws.py adapts a real
`WebSocket`; tests adapt an in-memory recorder.

SAFETY-1 lives in _handle_utterance: the red-flag matcher (safety/red_flags.py)
runs and is checked *before* any LLM-derived response is spoken, on every
finalized segment, independent of whether the LLM call even succeeds.
"""

import asyncio
import time
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from enum import Enum
from typing import Protocol

import structlog
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.config import get_settings
from app.models.user import PatientProfile, User
from app.models.voice import VoiceSession, VoiceTurn
from app.safety import escalation
from app.safety.output_guard import guard as guard_output
from app.models.emergency import EmergencyQueueEntry
from app.rag.retriever import retrieve
from app.safety.red_flags import (
    TIER_CRITICAL,
    TIER_ROUTINE,
    TIER_URGENT,
    RedFlagHit,
    match_timed,
)
from app.voice.agent import render_system_prompt, run_agent_turn
from app.voice.tools import ToolContext
from app.voice.tts_text import normalize_for_tts

logger = structlog.get_logger(__name__)
settings = get_settings()

ROLLING_WINDOW_TURNS = 3
IDLE_PROMPT_SECONDS = 45
IDLE_CLOSE_SECONDS = 30
HARD_TIMEOUT_MINUTES = 15


class SessionState(str, Enum):
    idle = "idle"
    greeting = "greeting"
    listening = "listening"
    transcribing = "transcribing"
    thinking = "thinking"
    speaking = "speaking"
    emergency = "emergency"
    closing = "closing"


class VoiceTransport(Protocol):
    async def send_json(self, data: dict) -> None: ...
    async def send_bytes(self, data: bytes) -> None: ...


@dataclass
class _Turn:
    index: int
    speaker: str
    transcript: str | None
    tool_calls: list[dict] = field(default_factory=list)
    latency_ms: dict = field(default_factory=dict)
    stt_confidence: float | None = None


class VoiceOrchestrator:
    def __init__(
        self,
        *,
        voice_session_id: uuid.UUID,
        patient_id: uuid.UUID | None,
        hospital_id: uuid.UUID | None,
        transport: VoiceTransport,
        session_factory: async_sessionmaker,
        redis: Redis,
    ):
        self.voice_session_id = voice_session_id
        self.patient_id = patient_id
        self.hospital_id = hospital_id
        self.transport = transport
        self.session_factory = session_factory
        self.redis = redis

        self.state = SessionState.idle
        self.turn_index = 0
        self.collected_data: dict = {}
        self.conversation: list[dict] = []  # {"speaker": "patient"|"agent", "text": ...}
        self._recent_patient_utterances: list[str] = []
        # Triage state, surfaced to the agent each turn so it knows whether to
        # clarify acuity, run the emergency intake, or do routine booking intake.
        self.triage_tier: str = TIER_ROUTINE
        self._urgent_hit: RedFlagHit | None = None
        self._emergency_hit: RedFlagHit | None = None
        self._last_rag_ms: int = 0
        self._last_stt_confidence: float | None = None
        self._pending_turns: list[_Turn] = []
        self.tts_task: asyncio.Task | None = None
        self._closed = False

    # -----------------------------------------------------------------
    # Lifecycle
    # -----------------------------------------------------------------

    async def handle_session_start(self) -> None:
        self.state = SessionState.greeting
        start = time.monotonic()
        greeting_ms = int((time.monotonic() - start) * 1000)
        await self.transport.send_json({"type": "ready", "session_id": str(self.voice_session_id), "greeting_ms": greeting_ms})
        await self._speak_precomputed("Hello, I'm Aarogya, the appointment assistant. How can I help you today?")
        self.state = SessionState.listening

    async def handle_speech_end(self, text: str, confidence: float = 0.0) -> None:
        """A finalized browser transcript. STT runs client-side (Web Speech API),
        so this receives text, not audio.

        Note: EMERGENCY is terminal for the *routine booking* flow (section 10.2),
        not for the conversation. After escalating we still need to ask whether an
        ambulance is needed and capture a callback name/number, so the line stays
        open and utterances keep flowing to _handle_utterance, which routes them
        into the emergency intake instead of booking.
        """
        text = text.strip()
        if not text:
            self.state = SessionState.listening
            return

        self._last_stt_confidence = confidence
        await self.transport.send_json({"type": "final_transcript", "text": text, "confidence": confidence})
        await self._handle_utterance(text, {})

    async def handle_text_input(self, text: str) -> None:
        """Typed fallback -- same agent path as speech. Not a different code path:
        the red-flag matcher and every triage decision live in _handle_utterance,
        so typed and spoken input are treated identically by design."""
        self._last_stt_confidence = None
        await self._handle_utterance(text, {})

    async def handle_barge_in(self) -> None:
        """Must abort within 150ms (section 10.2) -- cancel the TTS task and clear
        the send buffer *before* anything else, then tell the client to stop."""
        if self.tts_task is not None and not self.tts_task.done():
            self.tts_task.cancel()
        await self.transport.send_json({"type": "stop_playback"})
        if self.state == SessionState.speaking:
            self.state = SessionState.listening

    async def handle_session_end(self, reason: str = "user_hangup") -> None:
        if self._closed:
            return
        self._closed = True
        self.state = SessionState.closing
        outcome = "escalated" if any(t.speaker == "system" for t in self._pending_turns) else self._infer_outcome()
        await self._persist_session(outcome=outcome)
        await self.transport.send_json({"type": "session_summary", "outcome": outcome})

    def _infer_outcome(self) -> str:
        if self.collected_data.get("booked_appointment_id"):
            return "booked"
        if self.collected_data.get("transfer_requested"):
            return "transferred"
        if not self.conversation:
            return "abandoned"
        return "info_only"

    # -----------------------------------------------------------------
    # Core turn handling
    # -----------------------------------------------------------------

    async def _handle_utterance(self, text: str, stage_latency: dict[str, int]) -> None:
        self._recent_patient_utterances.append(text)
        self._recent_patient_utterances = self._recent_patient_utterances[-ROLLING_WINDOW_TURNS:]
        self.conversation.append({"speaker": "patient", "text": text})
        self._pending_turns.append(
            _Turn(
                index=self.turn_index, speaker="patient", transcript=text,
                latency_ms=stage_latency, stt_confidence=self._last_stt_confidence,
            )
        )
        self.turn_index += 1

        # SAFETY-1: deterministic match, dispatched *before* (not after) the LLM
        # call, and checked first regardless of which finishes faster.
        t0 = time.monotonic()
        hit, red_flag_ms = match_timed(self._recent_patient_utterances)
        stage_latency["red_flag"] = red_flag_ms

        # Three-tier triage (safety/red_flags.py::_classify_tier):
        #   CRITICAL -> escalate now, on this utterance, before any LLM call.
        #   URGENT   -> concerning but not clearly acute (e.g. "chest pain once a
        #               day for months"). No banner: hand the agent a directive to
        #               ask focused acuity questions. The matcher re-runs on every
        #               subsequent turn, so an answer revealing acuity ("it's
        #               crushing right now") still escalates immediately.
        #   ROUTINE  -> no hit; normal booking/intake flow.
        # Latched, not derived from self.state: the intake turns that follow an
        # escalation legitimately cycle state through speaking -> listening, so
        # reading self.state here would look "not escalated" on the very next turn
        # and replay the whole emergency script (the rolling utterance window
        # still contains the original red-flag phrase, so match() keeps hitting).
        already_escalated = self._emergency_hit is not None
        self.triage_tier = hit.tier if hit is not None else TIER_ROUTINE
        if hit is not None and hit.tier == TIER_CRITICAL and not already_escalated:
            await self._handle_emergency(hit, text)
            return

        # "Goodbye" must always work. The model was observed ignoring an explicit
        # "please end the session" three turns running and offering a booking
        # instead, so ending is detected here rather than relying on it to call
        # the end_session tool.
        if self._wants_to_end(text) and self._emergency_hit is None:
            self.conversation.append({"speaker": "patient", "text": text})
            await self._speak_precomputed("Thanks for calling City Care Clinic. Take care, goodbye.")
            await self.handle_session_end(reason="user_said_goodbye")
            return

        # Ambulance need is a dispatch decision, so it is captured deterministically
        # here rather than trusting the model to remember a record_symptom_data
        # call -- same reasoning as SAFETY-1: anything a responder acts on must not
        # depend on the LLM behaving. Observed in testing: the agent told the
        # patient an ambulance was on the way while ambulance_required stayed NULL.
        if self._emergency_hit is not None and "ambulance_required" not in self.collected_data:
            await self._capture_ambulance_answer(text)

        if hit is not None and hit.tier == TIER_URGENT:
            self._urgent_hit = hit
            logger.info(
                "red_flag_urgent_clarifying",
                flag_id=hit.id, category=hit.category, tier_reason=hit.tier_reason,
            )

        self.state = SessionState.thinking
        await self.transport.send_json({"type": "agent_thinking"})

        t1 = time.monotonic()
        spoken_text, tool_calls = await self._run_agent(text)
        stage_latency["agent_total"] = int((time.monotonic() - t1) * 1000)
        stage_latency["rag"] = self._last_rag_ms
        stage_latency["tool_calls"] = len(tool_calls)
        # Surfaced per turn so a slow deployment is diagnosable from the admin
        # health dashboard instead of by guessing which stage is the bottleneck.
        logger.info(
            "voice_turn_latency",
            session_id=str(self.voice_session_id),
            agent_ms=stage_latency["agent_total"],
            rag_ms=stage_latency["rag"],
            tool_calls=len(tool_calls),
        )

        guarded_text = guard_output(spoken_text, session_id=str(self.voice_session_id))

        self.conversation.append({"speaker": "agent", "text": guarded_text})
        self._pending_turns.append(
            _Turn(index=self.turn_index, speaker="agent", transcript=guarded_text, tool_calls=tool_calls, latency_ms=stage_latency)
        )
        self.turn_index += 1

        await self._speak(guarded_text)

        # Close only after the farewell has been spoken. Never mid-emergency:
        # the line stays open there until the patient or a clinician ends it.
        if self.collected_data.get("end_session_requested") and self._emergency_hit is None:
            await self.handle_session_end(reason=str(self.collected_data["end_session_requested"]))
            return

        self.state = SessionState.listening

    # Explicit closings only. Deliberately does not include bare "thanks" or
    # "ok" -- those appear constantly mid-conversation and hanging up on them
    # would be worse than not hanging up at all.
    _END_PHRASES = (
        "end the session", "end session", "end the call", "end call",
        "goodbye", "good bye", "bye bye", "that is all", "thats all",
        "that's all", "nothing else", "i am done", "im done", "i'm done",
        "we are done", "hang up", "stop the session", "close the session",
    )

    def _wants_to_end(self, text: str) -> bool:
        normalized = f" {text.lower().strip().rstrip('.!?')} "
        return any(p in normalized for p in self._END_PHRASES) or normalized.strip() == "bye"

    async def _capture_ambulance_answer(self, text: str) -> None:
        """Record a yes/no ambulance answer straight onto the emergency case.

        Only fires once the agent has actually asked (ambulance_required unset and
        an escalation is live), so a patient volunteering "no I drove myself here"
        mid-description isn't misread as an answer to a question nobody asked.
        """
        normalized = f" {text.lower().strip()} "
        yes = any(c in normalized for c in (" yes ", " yeah ", " yep ", " please send", " send one", " i need", " haan "))
        no = any(c in normalized for c in (" no ", " nope ", " not needed", " dont need", " do not need", " ill come", " i will come", " nahi "))
        if yes == no:
            return  # neither, or contradictory -- let the agent ask again

        required = yes
        self.collected_data["ambulance_required"] = "yes" if required else "no"
        case_id = self.collected_data.get("emergency_case_id")
        if not case_id:
            return
        async with self.session_factory() as session:
            entry = await session.get(EmergencyQueueEntry, uuid.UUID(case_id))
            if entry is not None:
                entry.ambulance_required = required
                await session.commit()
        logger.info("emergency_ambulance_recorded", case_id=case_id, ambulance_required=required)

    async def _retrieve_context(self, session, patient_text: str) -> str:
        """Pull clinic/triage knowledge relevant to what the patient just said.

        This was previously hardcoded to "" -- the system prompt has always had a
        {retrieved_chunks} slot, but nothing ever filled it, so the entire seeded
        knowledge base was dead weight for the voice agent.

        SAFETY-5: audience is pinned to "patient" and clinical_kb is deliberately
        excluded, so doctor-only material (differentials, workup protocols) can
        never reach a patient-facing answer. Best-effort: retrieval failing must
        degrade the answer, not break the turn.
        """
        self._last_rag_ms = 0
        if not settings.VOICE_RAG_PER_TURN:
            # Off by default -- see config.VOICE_RAG_PER_TURN. The agent reaches
            # the knowledge base on demand through the lookup_clinic_info tool.
            return ""
        started = time.monotonic()
        try:
            results = await retrieve(
                session,
                patient_text,
                namespaces=["clinic_kb", "triage_kb"],
                audience="patient",
                patient_id=self.patient_id,
                k=4,
                redis=self.redis,
            )
        except Exception as e:  # noqa: BLE001 -- see docstring
            logger.warning("voice_rag_retrieval_failed", error=str(e))
            return ""
        finally:
            self._last_rag_ms = int((time.monotonic() - started) * 1000)
        return "\n\n".join(c.content for c in results)

    def _triage_directive(self) -> str:
        """Per-tier intake script appended to the system prompt each turn.

        The tier is decided deterministically (safety/red_flags.py), never by the
        model -- this only tells the model what to *ask* once that decision is
        made, so a prompt-injection or a confused model cannot talk itself out of
        an escalation that already happened.
        """
        have = self.collected_data
        missing_contact = [f for f in ("patient_name", "patient_phone") if not have.get(f)]
        contact_ask = (
            f" Still needed: {', '.join(missing_contact)}." if missing_contact else " Contact details are complete."
        )

        if self._emergency_hit is not None:
            ambulance_known = "ambulance_required" in have
            return (
                "=== TRIAGE: EMERGENCY IN PROGRESS ===\n"
                "Emergency guidance and the helpline numbers are ALREADY on the patient's screen. "
                "Do not repeat the emergency numbers. Stay calm and brief.\n"
                + (
                    "Ask now, in one short sentence, whether they need an ambulance sent to them.\n"
                    if not ambulance_known
                    else "Ambulance preference recorded.\n"
                )
                + "Then collect their full name and a phone number so the on-call doctor can call back."
                + contact_ask
                + "\nUse record_symptom_data to save each answer (fields: ambulance_required, patient_name, patient_phone). "
                "Then use book_emergency_appointment to reserve an emergency slot at the nearest hospital. "
                "Never return to routine appointment booking."
            )

        if self.triage_tier == TIER_URGENT:
            cat = self._urgent_hit.category if self._urgent_hit else "this symptom"
            return (
                "=== TRIAGE: URGENT -- CLARIFY ACUITY ===\n"
                f"The patient mentioned something potentially serious ({cat}), but described it in a "
                "chronic or mild way, so this is NOT being treated as an emergency yet.\n"
                "Ask focused questions to establish how acute it is -- for example: is it happening "
                "right now, how severe out of ten, is it getting worse, and are there any associated "
                "symptoms (breathlessness, sweating, radiating pain, dizziness).\n"
                "Ask ONE question per turn and just speak it -- do NOT call a tool merely to "
                "acknowledge or store what the patient said; the full transcript is saved for the "
                "doctor automatically. After you understand the severity, collect their name and "
                "phone number, then help them book with a suitable doctor." + contact_ask
            )

        return (
            "=== TRIAGE: ROUTINE ===\n"
            + self._intake_phase_instruction()
            + "\nAsk at most ONE question per turn, and never re-ask something already answered above.\n"
            "Do NOT call a tool just to record or acknowledge an answer -- the whole conversation is "
            "already saved for the doctor, and every tool call adds several seconds of silence before "
            "the patient hears you. Speak your question directly. Use tools only to actually do "
            "something: record_symptom_data for the name/phone once you have them, then "
            "search_doctors / check_availability / book_appointment to book."
        )

    # Enough history for the doctor to prepare, without interrogating the patient.
    MAX_INTAKE_QUESTIONS = 3

    def _intake_phase_instruction(self) -> str:
        """Move intake -> booking on a turn count, not on the model's judgement.

        Observed failure this prevents: told to "ask at least three questions
        about the problem", the model fixated on one unanswered question
        ("severity out of ten") and re-asked it on every turn, ignoring "book the
        first available slot", "confirm it please" and even "end the session".
        It made zero tool calls and booked nothing. Counting turns here means the
        conversation always advances even when the model would not let it.
        """
        # No -1 here: the greeting is spoken via _speak_precomputed and never
        # enters self.conversation, so every agent entry is a real question.
        asked = sum(1 for t in self.conversation if t["speaker"] == "agent")
        if asked < self.MAX_INTAKE_QUESTIONS:
            remaining = self.MAX_INTAKE_QUESTIONS - asked
            return (
                f"PHASE: gathering history ({remaining} more question(s), then book).\n"
                "Ask about the main symptom, when it started and how it has changed, and anything "
                "that makes it better or worse. If the patient has already told you something, do "
                "not ask it again -- move to the next gap."
            )
        return (
            "PHASE: BOOK NOW. You have gathered enough history -- stop asking about symptoms.\n"
            "Proceed to booking now: search_doctors, then check_availability, then "
            "book_appointment. Only tell the patient it is booked AFTER book_appointment "
            "returns ok -- never announce a booking you have not actually made."
        )

    async def _run_agent(self, patient_text: str) -> tuple[str, list[dict]]:
        async with self.session_factory() as session:
            ctx = ToolContext(session=session, redis=self.redis, patient_id=self.patient_id, voice_session_id=self.voice_session_id, collected_data=self.collected_data)
            patient_context = await self._render_patient_context(session)
            system_prompt, _ = render_system_prompt(
                clinic_name=settings.CLINIC_NAME,
                retrieved_chunks=await self._retrieve_context(session, patient_text),
                patient_context=patient_context,
                collected_data=str(self.collected_data),
            )
            system_prompt = f"{system_prompt}\n\n{self._triage_directive()}"
            result = await run_agent_turn(ctx, system_prompt=system_prompt, conversation=self.conversation)
            self.collected_data.update(ctx.collected_data)
            for call in result.tool_calls:
                if call["tool"] == "book_appointment" and call["result"].get("ok"):
                    self.collected_data["booked_appointment_id"] = call["result"].get("appointment_id")
                    await self.transport.send_json(
                        {"type": "booking_confirmed", "appointment_id": call["result"]["appointment_id"], "payload": call["result"]}
                    )
            return result.spoken_text, result.tool_calls

    async def _render_patient_context(self, session) -> str:
        if self.patient_id is None:
            return "No patient record linked yet."
        user = await session.get(User, self.patient_id)
        profile = await session.get(PatientProfile, self.patient_id)
        if user is None:
            return "No patient record found."
        parts = [f"Name: {user.full_name}"]
        if profile:
            if profile.allergies:
                parts.append(f"Allergies: {', '.join(profile.allergies)}")
            if profile.chronic_conditions:
                parts.append(f"Chronic conditions: {', '.join(profile.chronic_conditions)}")
        return "; ".join(parts)

    # -----------------------------------------------------------------
    # Emergency (section 9.2, escalation.py)
    # -----------------------------------------------------------------

    async def _handle_emergency(self, hit: RedFlagHit, transcript_excerpt: str) -> None:
        # Step 1: cancel in-flight LLM work and stop any playing audio, within 300ms.
        if self.tts_task is not None and not self.tts_task.done():
            self.tts_task.cancel()
        await self.transport.send_json({"type": "stop_playback"})

        # Step 2: speak the fixed script -- never LLM-generated. _speak_precomputed
        # sets self.state = speaking as an implementation detail of "audio is
        # playing"; EMERGENCY is the authoritative state for the rest of this
        # flow, so it's (re-)set after, not before.
        script_text = escalation.get_script_text(hit.script_id)
        await self._speak_precomputed(script_text)
        self.state = SessionState.emergency

        # Step 3: client renders EmergencyBanner.
        await self.transport.send_json(
            {"type": "emergency", "severity": hit.severity, "category": hit.category, "numbers": escalation.numbers_for(hit.script_id)}
        )

        self._pending_turns.append(_Turn(index=self.turn_index, speaker="system", transcript=f"[EMERGENCY: {hit.id}] {script_text}"))
        self.turn_index += 1

        # Steps 4-7: persist, queue, notify, kick off the decision-support brief.
        # None of this blocks the spoken response above.
        async with self.session_factory() as session:
            entry = await escalation.record_emergency(
                session, hit=hit, voice_session_id=self.voice_session_id, patient_id=self.patient_id,
                hospital_id=self.hospital_id, transcript_excerpt=transcript_excerpt,
            )
            # Remembered so the follow-up intake turns (ambulance? callback
            # number?) can attach their answers to this exact case.
            self._emergency_hit = hit
            self.collected_data["emergency_case_id"] = str(entry.id)
            self.collected_data["emergency_category"] = hit.category
            try:
                await escalation.generate_emergency_brief(session, self.redis, entry=entry, patient_id=self.patient_id)
            except Exception as e:  # noqa: BLE001 -- the case and alert already exist; the brief is best-effort
                logger.error("emergency_brief_generation_failed", entry_id=str(entry.id), error=str(e))

        # Step 8: keep the line open. The banner and numbers are already on
        # screen; now hand the turn back so the agent can ask about an ambulance
        # and capture callback details (see _triage_directive).

    # -----------------------------------------------------------------
    # TTS output
    # -----------------------------------------------------------------

    async def _speak(self, text: str) -> None:
        """Send text for the client to speak via the browser's speechSynthesis.

        Section 18 named browser SpeechSynthesis as the TTS fallback; it is now
        the only TTS. The server never sends audio -- `agent_text` carries the
        caption (which always renders, per section 18) and `audio_start` /
        `audio_end` bracket it so the client knows when to start speaking and when
        the turn is over.

        normalize_for_tts runs here rather than client-side because it is the same
        transformation Piper needed -- expanding "10:30" to "ten thirty" and
        abbreviations -- and it is already tested (tests/test_tts_text.py).
        """
        self.state = SessionState.speaking
        spoken = normalize_for_tts(text)
        await self.transport.send_json({"type": "agent_text", "text": text, "speak_text": spoken, "is_final": True})
        await self.transport.send_json({"type": "audio_start"})
        await self.transport.send_json({"type": "audio_end"})

    async def _speak_precomputed(self, text: str, *_legacy) -> None:
        """Fixed content (greeting, emergency scripts).

        Kept as a separate entry point from _speak even though both now just send
        text: these strings are never LLM-generated and must never be routed
        through the output guard or the agent loop (SAFETY-1). The trailing
        *_legacy absorbs the old (pcm, rate) arguments from callers not yet
        updated.
        """
        self.state = SessionState.speaking
        spoken = normalize_for_tts(text)
        await self.transport.send_json({"type": "agent_text", "text": text, "speak_text": spoken, "is_final": True})
        await self.transport.send_json({"type": "audio_start"})
        await self.transport.send_json({"type": "audio_end"})

    # -----------------------------------------------------------------
    # Persistence
    # -----------------------------------------------------------------

    async def _persist_session(self, *, outcome: str) -> None:
        async with self.session_factory() as session:
            voice_session = await session.get(VoiceSession, self.voice_session_id)
            if voice_session is None:
                return
            voice_session.ended_at = datetime.now(UTC)
            voice_session.outcome = outcome
            voice_session.collected_data = self.collected_data
            voice_session.audio_retention_until = (
                datetime.now(UTC) + timedelta(days=settings.AUDIO_RETENTION_DAYS)
            ).date()
            for turn in self._pending_turns:
                session.add(
                    VoiceTurn(
                        session_id=self.voice_session_id, turn_index=turn.index, speaker=turn.speaker,
                        transcript=turn.transcript, tool_calls=turn.tool_calls or None, latency_ms=turn.latency_ms or None,
                        stt_confidence=turn.stt_confidence,
                    )
                )
            await session.commit()
