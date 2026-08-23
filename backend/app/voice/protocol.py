"""WebSocket JSON control frames -- IMPLEMENTATION.md section 10.1.

Deviation from section 10.1, deliberate: the protocol is now **JSON-only in both
directions**. Section 10.1 specified binary PCM16 frames upstream (browser mic ->
faster-whisper) and downstream (Piper -> browser). Both speech engines now run in
the browser -- SpeechRecognition for STT, speechSynthesis for TTS -- so the
client sends final transcript text on `speech_end`, and the server sends
`agent_text` for the client to speak. This removed ~1GB of model weights from the
image, which is what makes a free-tier deployment feasible.
"""

from typing import Literal

from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# Client -> server
# ---------------------------------------------------------------------------


class SessionStartIn(BaseModel):
    type: Literal["session_start"] = "session_start"
    consent_version: str
    patient_id: str | None = None
    language: str = "en"


class SpeechStartIn(BaseModel):
    type: Literal["speech_start"] = "speech_start"
    ts: int


class SpeechEndIn(BaseModel):
    """Carries the transcript itself: STT runs in the browser (Web Speech API),
    so the client sends final text rather than PCM. `text` is required -- a
    speech_end with nothing recognised should simply not be sent."""

    type: Literal["speech_end"] = "speech_end"
    ts: int
    duration_ms: int
    text: str
    confidence: float = 0.0


class BargeInIn(BaseModel):
    type: Literal["barge_in"] = "barge_in"


class TextInputIn(BaseModel):
    type: Literal["text_input"] = "text_input"
    text: str


class DtmfChoiceIn(BaseModel):
    type: Literal["dtmf_choice"] = "dtmf_choice"
    choice: str


class SessionEndIn(BaseModel):
    type: Literal["session_end"] = "session_end"
    reason: str = "user_hangup"


CLIENT_MESSAGE_TYPES: dict[str, type[BaseModel]] = {
    "session_start": SessionStartIn,
    "speech_start": SpeechStartIn,
    "speech_end": SpeechEndIn,
    "barge_in": BargeInIn,
    "text_input": TextInputIn,
    "dtmf_choice": DtmfChoiceIn,
    "session_end": SessionEndIn,
}


def parse_client_message(raw: dict) -> BaseModel:
    msg_type = raw.get("type")
    model = CLIENT_MESSAGE_TYPES.get(msg_type)
    if model is None:
        raise ValueError(f"Unknown client message type: {msg_type!r}")
    return model.model_validate(raw)


# ---------------------------------------------------------------------------
# Server -> client
# ---------------------------------------------------------------------------


class ReadyOut(BaseModel):
    type: Literal["ready"] = "ready"
    session_id: str
    greeting_ms: int


class PartialTranscriptOut(BaseModel):
    type: Literal["partial_transcript"] = "partial_transcript"
    text: str


class FinalTranscriptOut(BaseModel):
    type: Literal["final_transcript"] = "final_transcript"
    text: str
    confidence: float


class AgentThinkingOut(BaseModel):
    type: Literal["agent_thinking"] = "agent_thinking"


class AgentTextOut(BaseModel):
    type: Literal["agent_text"] = "agent_text"
    text: str
    is_final: bool = False


class AudioStartOut(BaseModel):
    type: Literal["audio_start"] = "audio_start"
    chunk_count_hint: int = 0


class AudioEndOut(BaseModel):
    type: Literal["audio_end"] = "audio_end"


class StopPlaybackOut(BaseModel):
    type: Literal["stop_playback"] = "stop_playback"


class ToolResultOut(BaseModel):
    type: Literal["tool_result"] = "tool_result"
    tool: str
    summary: str


class UiActionOut(BaseModel):
    type: Literal["ui_action"] = "ui_action"
    action: str
    payload: dict = Field(default_factory=dict)


class EmergencyOut(BaseModel):
    type: Literal["emergency"] = "emergency"
    severity: str
    category: str
    numbers: list[str]


class BookingConfirmedOut(BaseModel):
    type: Literal["booking_confirmed"] = "booking_confirmed"
    appointment_id: str
    payload: dict = Field(default_factory=dict)


class ErrorOut(BaseModel):
    type: Literal["error"] = "error"
    code: str
    recoverable: bool
    message: str


class SessionSummaryOut(BaseModel):
    type: Literal["session_summary"] = "session_summary"
    outcome: str
