import uuid
from datetime import date, datetime

from sqlalchemy import Boolean, CheckConstraint, Date, ForeignKey, Integer, Text, UniqueConstraint, func, text
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class VoiceSession(Base):
    __tablename__ = "voice_sessions"

    id: Mapped[uuid.UUID] = mapped_column(
        postgresql.UUID(as_uuid=True), primary_key=True, server_default=text("uuid_generate_v4()")
    )
    patient_id: Mapped[uuid.UUID | None] = mapped_column(
        postgresql.UUID(as_uuid=True), ForeignKey("users.id")
    )
    consent_given_at: Mapped[datetime] = mapped_column(postgresql.TIMESTAMP(timezone=True), nullable=False)
    consent_version: Mapped[str] = mapped_column(Text, nullable=False)
    started_at: Mapped[datetime] = mapped_column(
        postgresql.TIMESTAMP(timezone=True), nullable=False, server_default=func.now()
    )
    ended_at: Mapped[datetime | None] = mapped_column(postgresql.TIMESTAMP(timezone=True))
    outcome: Mapped[str | None] = mapped_column(Text)  # booked|escalated|abandoned|transferred|info_only
    appointment_id: Mapped[uuid.UUID | None] = mapped_column(
        postgresql.UUID(as_uuid=True), ForeignKey("appointments.id")
    )
    collected_data: Mapped[dict] = mapped_column(
        postgresql.JSONB, nullable=False, server_default=text("'{}'")
    )
    emergency_triggered: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    red_flags_matched: Mapped[list[str]] = mapped_column(
        postgresql.ARRAY(Text), nullable=False, server_default=text("'{}'")
    )
    audio_retention_until: Mapped[date | None] = mapped_column(Date)
    metrics: Mapped[dict | None] = mapped_column(postgresql.JSONB)

    turns: Mapped[list["VoiceTurn"]] = relationship(back_populates="session", cascade="all, delete-orphan")


class VoiceTurn(Base):
    __tablename__ = "voice_turns"
    __table_args__ = (UniqueConstraint("session_id", "turn_index"),)

    id: Mapped[uuid.UUID] = mapped_column(
        postgresql.UUID(as_uuid=True), primary_key=True, server_default=text("uuid_generate_v4()")
    )
    session_id: Mapped[uuid.UUID] = mapped_column(
        postgresql.UUID(as_uuid=True), ForeignKey("voice_sessions.id", ondelete="CASCADE"), nullable=False
    )
    turn_index: Mapped[int] = mapped_column(Integer, nullable=False)
    speaker: Mapped[str] = mapped_column(
        Text, CheckConstraint("speaker IN ('patient','agent','system')"), nullable=False
    )
    transcript: Mapped[str | None] = mapped_column(Text)
    stt_confidence: Mapped[float | None] = mapped_column(postgresql.REAL)
    tool_calls: Mapped[dict | list | None] = mapped_column(postgresql.JSONB)
    latency_ms: Mapped[dict | None] = mapped_column(postgresql.JSONB)
    created_at: Mapped[datetime] = mapped_column(
        postgresql.TIMESTAMP(timezone=True), nullable=False, server_default=func.now()
    )

    session: Mapped["VoiceSession"] = relationship(back_populates="turns")
