import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, ForeignKey, Text, func, text
from sqlalchemy.dialects import postgresql
from sqlalchemy.dialects.postgresql import ExcludeConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.models._types import pg_enum
from app.models.enums import AppointmentKind, AppointmentStatus, UrgencyLevel


class Appointment(Base):
    __tablename__ = "appointments"

    id: Mapped[uuid.UUID] = mapped_column(
        postgresql.UUID(as_uuid=True), primary_key=True, server_default=text("uuid_generate_v4()")
    )
    doctor_id: Mapped[uuid.UUID] = mapped_column(
        postgresql.UUID(as_uuid=True), ForeignKey("doctor_profiles.user_id"), nullable=False
    )
    patient_id: Mapped[uuid.UUID] = mapped_column(
        postgresql.UUID(as_uuid=True), ForeignKey("users.id"), nullable=False
    )
    hospital_id: Mapped[uuid.UUID | None] = mapped_column(
        postgresql.UUID(as_uuid=True), ForeignKey("hospitals.id")
    )
    start_at: Mapped[datetime] = mapped_column(postgresql.TIMESTAMP(timezone=True), nullable=False)
    end_at: Mapped[datetime] = mapped_column(postgresql.TIMESTAMP(timezone=True), nullable=False)
    status: Mapped[AppointmentStatus] = mapped_column(
        pg_enum(AppointmentStatus, "appointment_status"),
        nullable=False,
        server_default=text("'held'"),
    )
    kind: Mapped[AppointmentKind] = mapped_column(
        pg_enum(AppointmentKind, "appointment_kind"),
        nullable=False,
        server_default=text("'routine'"),
    )
    urgency: Mapped[UrgencyLevel | None] = mapped_column(pg_enum(UrgencyLevel, "urgency_level"))
    booking_channel: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'web'"))
    voice_session_id: Mapped[uuid.UUID | None] = mapped_column(postgresql.UUID(as_uuid=True))
    reason_text: Mapped[str | None] = mapped_column(Text)
    hold_expires_at: Mapped[datetime | None] = mapped_column(postgresql.TIMESTAMP(timezone=True))
    cancelled_at: Mapped[datetime | None] = mapped_column(postgresql.TIMESTAMP(timezone=True))
    cancelled_by: Mapped[uuid.UUID | None] = mapped_column(
        postgresql.UUID(as_uuid=True), ForeignKey("users.id")
    )
    cancellation_reason: Mapped[str | None] = mapped_column(Text)
    rescheduled_from: Mapped[uuid.UUID | None] = mapped_column(
        postgresql.UUID(as_uuid=True), ForeignKey("appointments.id")
    )
    created_at: Mapped[datetime] = mapped_column(
        postgresql.TIMESTAMP(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        postgresql.TIMESTAMP(timezone=True), nullable=False, server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint("end_at > start_at", name="ck_appointments_end_after_start"),
        # THE critical invariant. This, not application code, prevents double booking.
        ExcludeConstraint(
            (doctor_id, "="),
            (func.tstzrange(start_at, end_at, text("'[)'")), "&&"),
            where=status.in_([AppointmentStatus.held, AppointmentStatus.confirmed]),
            using="gist",
            name="appointments_no_overlap",
        ),
    )
