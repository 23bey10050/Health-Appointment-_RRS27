import uuid
from datetime import datetime

from sqlalchemy import ForeignKey, Integer, LargeBinary, Text, UniqueConstraint, func, text
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models._types import pg_enum
from app.models.enums import OutboxStatus


class EmailOutbox(Base):
    __tablename__ = "email_outbox"

    id: Mapped[uuid.UUID] = mapped_column(
        postgresql.UUID(as_uuid=True), primary_key=True, server_default=text("uuid_generate_v4()")
    )
    idempotency_key: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    to_email: Mapped[str] = mapped_column(Text, nullable=False)
    template: Mapped[str] = mapped_column(Text, nullable=False)
    context: Mapped[dict] = mapped_column(postgresql.JSONB, nullable=False)
    status: Mapped[OutboxStatus] = mapped_column(
        pg_enum(OutboxStatus, "outbox_status"), nullable=False, server_default=text("'pending'")
    )
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    max_attempts: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("5"))
    next_attempt_at: Mapped[datetime] = mapped_column(
        postgresql.TIMESTAMP(timezone=True), nullable=False, server_default=func.now()
    )
    last_error: Mapped[str | None] = mapped_column(Text)
    provider_message_id: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        postgresql.TIMESTAMP(timezone=True), nullable=False, server_default=func.now()
    )


class MedicationReminder(Base):
    __tablename__ = "medication_reminders"
    __table_args__ = (UniqueConstraint("prescription_id", "scheduled_at", "channel"),)

    id: Mapped[uuid.UUID] = mapped_column(
        postgresql.UUID(as_uuid=True), primary_key=True, server_default=text("uuid_generate_v4()")
    )
    prescription_id: Mapped[uuid.UUID] = mapped_column(
        postgresql.UUID(as_uuid=True), ForeignKey("prescriptions.id", ondelete="CASCADE"), nullable=False
    )
    patient_id: Mapped[uuid.UUID] = mapped_column(
        postgresql.UUID(as_uuid=True), ForeignKey("users.id"), nullable=False
    )
    scheduled_at: Mapped[datetime] = mapped_column(postgresql.TIMESTAMP(timezone=True), nullable=False)
    channel: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'email'"))  # email|webpush
    sent_at: Mapped[datetime | None] = mapped_column(postgresql.TIMESTAMP(timezone=True))
    acknowledged_at: Mapped[datetime | None] = mapped_column(postgresql.TIMESTAMP(timezone=True))


class CalendarLink(Base):
    __tablename__ = "calendar_links"
    __table_args__ = (UniqueConstraint("appointment_id", "user_id"),)

    id: Mapped[uuid.UUID] = mapped_column(
        postgresql.UUID(as_uuid=True), primary_key=True, server_default=text("uuid_generate_v4()")
    )
    appointment_id: Mapped[uuid.UUID] = mapped_column(
        postgresql.UUID(as_uuid=True), ForeignKey("appointments.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        postgresql.UUID(as_uuid=True), ForeignKey("users.id"), nullable=False
    )
    google_event_id: Mapped[str | None] = mapped_column(Text)
    calendar_id: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'primary'"))
    sync_state: Mapped[str] = mapped_column(
        Text, nullable=False, server_default=text("'pending'")
    )  # pending|synced|failed|deleted
    last_error: Mapped[str | None] = mapped_column(Text)


class GoogleOAuthToken(Base):
    __tablename__ = "google_oauth_tokens"

    user_id: Mapped[uuid.UUID] = mapped_column(
        postgresql.UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    refresh_token_encrypted: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)  # Fernet
    scopes: Mapped[list[str]] = mapped_column(postgresql.ARRAY(Text), nullable=False)
    connected_at: Mapped[datetime] = mapped_column(
        postgresql.TIMESTAMP(timezone=True), nullable=False, server_default=func.now()
    )
    revoked_at: Mapped[datetime | None] = mapped_column(postgresql.TIMESTAMP(timezone=True))
