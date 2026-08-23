import uuid
from datetime import date, datetime

from sqlalchemy import Boolean, Date, ForeignKey, Integer, Text, text
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.models._types import pg_enum
from app.models.enums import SummaryKind, SummaryState


class Encounter(Base):
    __tablename__ = "encounters"

    id: Mapped[uuid.UUID] = mapped_column(
        postgresql.UUID(as_uuid=True), primary_key=True, server_default=text("uuid_generate_v4()")
    )
    appointment_id: Mapped[uuid.UUID] = mapped_column(
        postgresql.UUID(as_uuid=True),
        ForeignKey("appointments.id", ondelete="CASCADE"),
        unique=True,
        nullable=False,
    )
    clinical_notes: Mapped[str | None] = mapped_column(Text)
    diagnosis: Mapped[str | None] = mapped_column(Text)
    vitals: Mapped[dict | None] = mapped_column(postgresql.JSONB)
    follow_up_after_days: Mapped[int | None] = mapped_column(Integer)
    submitted_at: Mapped[datetime | None] = mapped_column(postgresql.TIMESTAMP(timezone=True))
    submitted_by: Mapped[uuid.UUID | None] = mapped_column(
        postgresql.UUID(as_uuid=True), ForeignKey("users.id")
    )

    prescriptions: Mapped[list["Prescription"]] = relationship(
        back_populates="encounter", cascade="all, delete-orphan"
    )


class Prescription(Base):
    __tablename__ = "prescriptions"

    id: Mapped[uuid.UUID] = mapped_column(
        postgresql.UUID(as_uuid=True), primary_key=True, server_default=text("uuid_generate_v4()")
    )
    encounter_id: Mapped[uuid.UUID] = mapped_column(
        postgresql.UUID(as_uuid=True), ForeignKey("encounters.id", ondelete="CASCADE"), nullable=False
    )
    drug_name: Mapped[str] = mapped_column(Text, nullable=False)
    strength: Mapped[str | None] = mapped_column(Text)
    form: Mapped[str | None] = mapped_column(Text)
    frequency_code: Mapped[str] = mapped_column(Text, nullable=False)  # OD|BD|TDS|QID|HS|SOS|Q6H...
    times_of_day: Mapped[list] = mapped_column(postgresql.ARRAY(postgresql.TIME), nullable=False)
    relation_to_food: Mapped[str | None] = mapped_column(Text)  # before|after|with|any
    duration_days: Mapped[int] = mapped_column(Integer, nullable=False)
    start_date: Mapped[date] = mapped_column(Date, nullable=False)
    instructions: Mapped[str | None] = mapped_column(Text)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))

    encounter: Mapped["Encounter"] = relationship(back_populates="prescriptions")


class AISummary(Base):
    __tablename__ = "ai_summaries"

    id: Mapped[uuid.UUID] = mapped_column(
        postgresql.UUID(as_uuid=True), primary_key=True, server_default=text("uuid_generate_v4()")
    )
    kind: Mapped[SummaryKind] = mapped_column(pg_enum(SummaryKind, "summary_kind"), nullable=False)
    appointment_id: Mapped[uuid.UUID | None] = mapped_column(
        postgresql.UUID(as_uuid=True), ForeignKey("appointments.id", ondelete="CASCADE")
    )
    encounter_id: Mapped[uuid.UUID | None] = mapped_column(
        postgresql.UUID(as_uuid=True), ForeignKey("encounters.id", ondelete="CASCADE")
    )
    # Migration 0003: emergency_brief summaries link here instead of
    # appointment_id/encounter_id -- an emergency escalation bypasses the
    # appointments table entirely (see migration 0002).
    emergency_queue_id: Mapped[uuid.UUID | None] = mapped_column(
        postgresql.UUID(as_uuid=True), ForeignKey("emergency_queue.id", ondelete="CASCADE")
    )
    state: Mapped[SummaryState] = mapped_column(
        pg_enum(SummaryState, "summary_state"), nullable=False, server_default=text("'draft'")
    )
    content: Mapped[dict] = mapped_column(postgresql.JSONB, nullable=False)
    content_edited: Mapped[dict | None] = mapped_column(postgresql.JSONB)

    # provenance: required for audit
    model_provider: Mapped[str | None] = mapped_column(Text)
    model_name: Mapped[str | None] = mapped_column(Text)
    prompt_version: Mapped[str | None] = mapped_column(Text)
    retrieved_chunk_ids: Mapped[list[uuid.UUID] | None] = mapped_column(
        postgresql.ARRAY(postgresql.UUID(as_uuid=True))
    )
    input_token_count: Mapped[int | None] = mapped_column(Integer)
    output_token_count: Mapped[int | None] = mapped_column(Integer)
    latency_ms: Mapped[int | None] = mapped_column(Integer)
    generation_error: Mapped[str | None] = mapped_column(Text)

    reviewed_by: Mapped[uuid.UUID | None] = mapped_column(
        postgresql.UUID(as_uuid=True), ForeignKey("users.id")
    )
    reviewed_at: Mapped[datetime | None] = mapped_column(postgresql.TIMESTAMP(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        postgresql.TIMESTAMP(timezone=True), nullable=False, server_default=text("now()")
    )
