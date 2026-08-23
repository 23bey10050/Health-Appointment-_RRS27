"""IMPLEMENTATION.md section 19: "full session via a fake WS client." Exercises
the real orchestrator, real red-flag matcher, real output guard, and real LLM
router (which, with no provider keys configured in this test environment, takes
the real degraded-fallback path -- itself worth verifying, matching section 20
item 10: "test the emergency path with the LLM disabled").

Mostly uses text_input: typed input traverses the identical agent path as speech
(section 18), so these exercise the same orchestrator/agent/safety code either way.
Since STT moved to the browser, handle_speech_end also takes plain text, and the
only difference between the two entry points is the final_transcript echo and the
recorded confidence.
"""

import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import select

from app.models.emergency import EmergencyQueueEntry
from app.models.voice import VoiceSession, VoiceTurn
from app.voice.orchestrator import SessionState, VoiceOrchestrator


class FakeTransport:
    def __init__(self):
        self.json_messages: list[dict] = []
        self.byte_frames: list[bytes] = []

    async def send_json(self, data: dict) -> None:
        self.json_messages.append(data)

    async def send_bytes(self, data: bytes) -> None:
        self.byte_frames.append(data)

    def messages_of_type(self, msg_type: str) -> list[dict]:
        return [m for m in self.json_messages if m.get("type") == msg_type]


class FakeRedis:
    """In-memory stand-in for llm/redact.py's session-keyed PHI map and
    rag/retriever.py's retrieval cache -- real code paths, no real Redis needed."""

    def __init__(self):
        self.store: dict[str, str] = {}

    async def get(self, key):
        return self.store.get(key)

    async def set(self, key, value, ex=None):
        self.store[key] = value


async def _make_voice_session(db_session, *, patient_id=None) -> uuid.UUID:
    vs = VoiceSession(patient_id=patient_id, consent_given_at=datetime.now(UTC), consent_version="v1")
    db_session.add(vs)
    await db_session.commit()
    await db_session.refresh(vs)
    return vs.id


@pytest.mark.asyncio
async def test_session_start_sends_ready_and_greeting(db_session, test_sessionmaker):
    voice_session_id = await _make_voice_session(db_session)
    transport = FakeTransport()
    orchestrator = VoiceOrchestrator(
        voice_session_id=voice_session_id, patient_id=None, hospital_id=None,
        transport=transport, session_factory=test_sessionmaker, redis=FakeRedis(),
    )

    await orchestrator.handle_session_start()

    assert orchestrator.state == SessionState.listening
    assert transport.messages_of_type("ready")
    agent_text = transport.messages_of_type("agent_text")
    assert agent_text and "Aarogya" in agent_text[0]["text"]
    assert transport.messages_of_type("audio_start")
    assert transport.messages_of_type("audio_end")


@pytest.mark.asyncio
async def test_benign_text_input_goes_through_agent_and_gets_a_response(db_session, test_sessionmaker):
    voice_session_id = await _make_voice_session(db_session)
    transport = FakeTransport()
    orchestrator = VoiceOrchestrator(
        voice_session_id=voice_session_id, patient_id=None, hospital_id=None,
        transport=transport, session_factory=test_sessionmaker, redis=FakeRedis(),
    )
    orchestrator.state = SessionState.listening

    await orchestrator.handle_text_input("What are your clinic hours?")

    assert orchestrator.state == SessionState.listening  # back to listening after speaking
    assert transport.messages_of_type("agent_thinking")
    agent_texts = transport.messages_of_type("agent_text")
    assert len(agent_texts) >= 1
    # No emergency frame for a benign question.
    assert not transport.messages_of_type("emergency")
    assert len(orchestrator.conversation) == 2  # patient + agent


@pytest.mark.asyncio
async def test_red_flag_utterance_preempts_the_agent_and_escalates(db_session, test_sessionmaker, seeded_patient):
    """The critical path: SAFETY-1. A red-flag utterance must short-circuit
    straight to the emergency script -- never reach the (here, provider-less and
    guaranteed-to-fail) LLM agent loop at all."""
    voice_session_id = await _make_voice_session(db_session, patient_id=seeded_patient)
    transport = FakeTransport()
    orchestrator = VoiceOrchestrator(
        voice_session_id=voice_session_id, patient_id=seeded_patient, hospital_id=None,
        transport=transport, session_factory=test_sessionmaker, redis=FakeRedis(),
    )
    orchestrator.state = SessionState.listening

    await orchestrator.handle_text_input("I have crushing pain in my chest and my left arm hurts")

    assert orchestrator.state == SessionState.emergency
    emergency_frames = transport.messages_of_type("emergency")
    assert len(emergency_frames) == 1
    assert emergency_frames[0]["category"] == "cardiac"
    assert "108" in emergency_frames[0]["numbers"]

    stop_playback = transport.messages_of_type("stop_playback")
    assert stop_playback  # section 9.2 step 1

    agent_texts = transport.messages_of_type("agent_text")
    assert any("108" in m["text"] or "one zero eight" in m["text"] for m in agent_texts)
    # No agent_thinking frame -- confirms the LLM path was never entered.
    assert not transport.messages_of_type("agent_thinking")


@pytest.mark.asyncio
async def test_red_flag_creates_emergency_queue_entry(db_session, test_sessionmaker, seeded_patient):
    voice_session_id = await _make_voice_session(db_session, patient_id=seeded_patient)
    transport = FakeTransport()
    orchestrator = VoiceOrchestrator(
        voice_session_id=voice_session_id, patient_id=seeded_patient, hospital_id=None,
        transport=transport, session_factory=test_sessionmaker, redis=FakeRedis(),
    )
    orchestrator.state = SessionState.listening

    await orchestrator.handle_text_input("She's having a seizure right now")

    async with test_sessionmaker() as session:
        entries = (await session.scalars(select(EmergencyQueueEntry))).all()
        assert len(entries) == 1
        assert entries[0].category == "neuro"
        assert entries[0].patient_id == seeded_patient

        vs = await session.get(VoiceSession, voice_session_id)
        assert vs.emergency_triggered is True
        assert "active_seizure" in vs.red_flags_matched


@pytest.mark.asyncio
async def test_empty_transcript_is_ignored(db_session, test_sessionmaker, seeded_patient):
    """The browser can fire speech_end with nothing recognised (background noise,
    a cough). That must not start a turn."""
    voice_session_id = await _make_voice_session(db_session, patient_id=seeded_patient)
    transport = FakeTransport()
    orchestrator = VoiceOrchestrator(
        voice_session_id=voice_session_id, patient_id=seeded_patient, hospital_id=None,
        transport=transport, session_factory=test_sessionmaker, redis=FakeRedis(),
    )

    frames_before = len(transport.json_messages)
    await orchestrator.handle_speech_end("   ", confidence=0.0)
    assert len(transport.json_messages) == frames_before
    assert orchestrator.state == SessionState.listening


@pytest.mark.asyncio
async def test_emergency_intake_continues_after_escalation(db_session, test_sessionmaker, seeded_patient):
    """EMERGENCY is terminal for the *routine booking* flow (section 10.2), but the
    line stays open: after escalating we still need to ask about an ambulance and
    capture callback details, so further utterances must still be processed."""
    voice_session_id = await _make_voice_session(db_session, patient_id=seeded_patient)
    transport = FakeTransport()
    orchestrator = VoiceOrchestrator(
        voice_session_id=voice_session_id, patient_id=seeded_patient, hospital_id=None,
        transport=transport, session_factory=test_sessionmaker, redis=FakeRedis(),
    )
    orchestrator.state = SessionState.emergency

    frames_before = len(transport.json_messages)
    await orchestrator.handle_speech_end("yes please send an ambulance", confidence=0.9)
    assert len(transport.json_messages) > frames_before, "emergency intake must keep responding"


@pytest.mark.asyncio
async def test_barge_in_stops_playback_and_returns_to_listening(db_session, test_sessionmaker):
    voice_session_id = await _make_voice_session(db_session)
    transport = FakeTransport()
    orchestrator = VoiceOrchestrator(
        voice_session_id=voice_session_id, patient_id=None, hospital_id=None,
        transport=transport, session_factory=test_sessionmaker, redis=FakeRedis(),
    )
    orchestrator.state = SessionState.speaking

    await orchestrator.handle_barge_in()

    assert orchestrator.state == SessionState.listening
    assert transport.messages_of_type("stop_playback")


@pytest.mark.asyncio
async def test_session_end_persists_turns_and_sends_summary(db_session, test_sessionmaker):
    voice_session_id = await _make_voice_session(db_session)
    transport = FakeTransport()
    orchestrator = VoiceOrchestrator(
        voice_session_id=voice_session_id, patient_id=None, hospital_id=None,
        transport=transport, session_factory=test_sessionmaker, redis=FakeRedis(),
    )
    orchestrator.state = SessionState.listening
    await orchestrator.handle_text_input("Hi there")

    await orchestrator.handle_session_end("user_hangup")

    summaries = transport.messages_of_type("session_summary")
    assert len(summaries) == 1

    async with test_sessionmaker() as session:
        vs = await session.get(VoiceSession, voice_session_id)
        assert vs.ended_at is not None
        assert vs.outcome is not None
        turns = (await session.scalars(select(VoiceTurn).where(VoiceTurn.session_id == voice_session_id))).all()
        assert len(turns) >= 2  # patient turn + agent turn
        speakers = {t.speaker for t in turns}
        assert "patient" in speakers
        assert "agent" in speakers


@pytest.mark.asyncio
async def test_session_end_is_idempotent(db_session, test_sessionmaker):
    voice_session_id = await _make_voice_session(db_session)
    transport = FakeTransport()
    orchestrator = VoiceOrchestrator(
        voice_session_id=voice_session_id, patient_id=None, hospital_id=None,
        transport=transport, session_factory=test_sessionmaker, redis=FakeRedis(),
    )
    await orchestrator.handle_session_end("user_hangup")
    await orchestrator.handle_session_end("connection_dropped")  # must not double-persist or error

    assert len(transport.messages_of_type("session_summary")) == 1
