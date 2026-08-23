import enum
import uuid
from datetime import datetime

from sqlalchemy import Boolean, ForeignKey, Text, func, text
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models._types import pg_enum


class EmergencyQueueStatus(str, enum.Enum):
    active = "active"
    acknowledged = "acknowledged"
    resolved = "resolved"


class EmergencyQueueEntry(Base):
    __tablename__ = "emergency_queue"

    id: Mapped[uuid.UUID] = mapped_column(
        postgresql.UUID(as_uuid=True), primary_key=True, server_default=text("uuid_generate_v4()")
    )
    patient_id: Mapped[uuid.UUID | None] = mapped_column(
        postgresql.UUID(as_uuid=True), ForeignKey("users.id")
    )
    hospital_id: Mapped[uuid.UUID | None] = mapped_column(
        postgresql.UUID(as_uuid=True), ForeignKey("hospitals.id")
    )
    voice_session_id: Mapped[uuid.UUID | None] = mapped_column(
        postgresql.UUID(as_uuid=True), ForeignKey("voice_sessions.id")
    )
    category: Mapped[str] = mapped_column(Text, nullable=False)
    severity: Mapped[str] = mapped_column(Text, nullable=False)
    summary: Mapped[str | None] = mapped_column(Text)
    status: Mapped[EmergencyQueueStatus] = mapped_column(
        pg_enum(EmergencyQueueStatus, "emergency_queue_status"),
        nullable=False,
        server_default=text("'active'"),
    )
    oncall_doctor_id: Mapped[uuid.UUID | None] = mapped_column(
        postgresql.UUID(as_uuid=True), ForeignKey("users.id")
    )
    # Migration 0004 -- captured by the voice agent's emergency intake, after the
    # banner is already up (the escalation itself never waits on these).
    ambulance_required: Mapped[bool | None] = mapped_column(Boolean)
    callback_name: Mapped[str | None] = mapped_column(Text)
    callback_phone: Mapped[str | None] = mapped_column(Text)
    appointment_id: Mapped[uuid.UUID | None] = mapped_column(
        postgresql.UUID(as_uuid=True), ForeignKey("appointments.id", ondelete="SET NULL")
    )
    created_at: Mapped[datetime] = mapped_column(
        postgresql.TIMESTAMP(timezone=True), nullable=False, server_default=func.now()
    )
    acknowledged_at: Mapped[datetime | None] = mapped_column(postgresql.TIMESTAMP(timezone=True))
    resolved_at: Mapped[datetime | None] = mapped_column(postgresql.TIMESTAMP(timezone=True))
