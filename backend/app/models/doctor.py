import uuid
from datetime import date, datetime, time

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    ForeignKey,
    Integer,
    Numeric,
    SmallInteger,
    Text,
    Time,
    func,
    text,
)
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class DoctorProfile(Base):
    __tablename__ = "doctor_profiles"

    user_id: Mapped[uuid.UUID] = mapped_column(
        postgresql.UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    hospital_id: Mapped[uuid.UUID | None] = mapped_column(
        postgresql.UUID(as_uuid=True), ForeignKey("hospitals.id")
    )
    specialisation: Mapped[str] = mapped_column(Text, nullable=False)
    sub_specialisations: Mapped[list[str]] = mapped_column(
        postgresql.ARRAY(Text), nullable=False, server_default=text("'{}'")
    )
    qualifications: Mapped[str | None] = mapped_column(Text)
    registration_no: Mapped[str | None] = mapped_column(Text)
    years_experience: Mapped[int | None] = mapped_column(Integer)
    bio: Mapped[str | None] = mapped_column(Text)
    consultation_fee: Mapped[float | None] = mapped_column(Numeric(10, 2))
    slot_duration_min: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("20"))
    buffer_min: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    max_daily_appointments: Mapped[int | None] = mapped_column(Integer)
    accepts_emergency: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    is_accepting: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))

    user: Mapped["User"] = relationship(back_populates="doctor_profile")  # noqa: F821
    working_hours: Mapped[list["DoctorWorkingHours"]] = relationship(
        back_populates="doctor", cascade="all, delete-orphan"
    )
    leaves: Mapped[list["DoctorLeave"]] = relationship(
        back_populates="doctor", cascade="all, delete-orphan"
    )


class DoctorWorkingHours(Base):
    __tablename__ = "doctor_working_hours"
    __table_args__ = (CheckConstraint("end_time > start_time", name="ck_working_hours_end_after_start"),)

    id: Mapped[uuid.UUID] = mapped_column(
        postgresql.UUID(as_uuid=True), primary_key=True, server_default=text("uuid_generate_v4()")
    )
    doctor_id: Mapped[uuid.UUID] = mapped_column(
        postgresql.UUID(as_uuid=True),
        ForeignKey("doctor_profiles.user_id", ondelete="CASCADE"),
        nullable=False,
    )
    weekday: Mapped[int] = mapped_column(
        SmallInteger, CheckConstraint("weekday BETWEEN 0 AND 6"), nullable=False
    )
    start_time: Mapped[time] = mapped_column(Time, nullable=False)
    end_time: Mapped[time] = mapped_column(Time, nullable=False)
    valid_from: Mapped[date] = mapped_column(Date, nullable=False, server_default=func.current_date())
    valid_until: Mapped[date | None] = mapped_column(Date)

    doctor: Mapped["DoctorProfile"] = relationship(back_populates="working_hours")


class DoctorLeave(Base):
    __tablename__ = "doctor_leave"
    __table_args__ = (CheckConstraint("end_date >= start_date", name="ck_leave_end_after_start"),)

    id: Mapped[uuid.UUID] = mapped_column(
        postgresql.UUID(as_uuid=True), primary_key=True, server_default=text("uuid_generate_v4()")
    )
    doctor_id: Mapped[uuid.UUID] = mapped_column(
        postgresql.UUID(as_uuid=True),
        ForeignKey("doctor_profiles.user_id", ondelete="CASCADE"),
        nullable=False,
    )
    start_date: Mapped[date] = mapped_column(Date, nullable=False)
    end_date: Mapped[date] = mapped_column(Date, nullable=False)
    reason: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        postgresql.UUID(as_uuid=True), ForeignKey("users.id")
    )
    created_at: Mapped[datetime] = mapped_column(
        postgresql.TIMESTAMP(timezone=True), nullable=False, server_default=func.now()
    )
    affected_appointments_handled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )

    doctor: Mapped["DoctorProfile"] = relationship(back_populates="leaves")
