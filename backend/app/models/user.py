import uuid
from datetime import datetime

from sqlalchemy import Boolean, Date, ForeignKey, Text, func, text
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.models._types import pg_enum
from app.models.enums import UserRole


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(
        postgresql.UUID(as_uuid=True), primary_key=True, server_default=text("uuid_generate_v4()")
    )
    email: Mapped[str] = mapped_column(postgresql.CITEXT, unique=True, nullable=False)
    phone: Mapped[str | None] = mapped_column(Text)
    password_hash: Mapped[str] = mapped_column(Text, nullable=False)
    role: Mapped[UserRole] = mapped_column(pg_enum(UserRole, "user_role"), nullable=False)
    full_name: Mapped[str] = mapped_column(Text, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))
    created_at: Mapped[datetime] = mapped_column(
        postgresql.TIMESTAMP(timezone=True), nullable=False, server_default=func.now()
    )

    patient_profile: Mapped["PatientProfile"] = relationship(
        back_populates="user", uselist=False, cascade="all, delete-orphan"
    )
    doctor_profile: Mapped["DoctorProfile"] = relationship(  # noqa: F821
        back_populates="user", uselist=False, cascade="all, delete-orphan"
    )


class PatientProfile(Base):
    __tablename__ = "patient_profiles"

    user_id: Mapped[uuid.UUID] = mapped_column(
        postgresql.UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    date_of_birth: Mapped[datetime | None] = mapped_column(Date)
    sex: Mapped[str | None] = mapped_column(Text)
    blood_group: Mapped[str | None] = mapped_column(Text)
    allergies: Mapped[list] = mapped_column(postgresql.JSONB, nullable=False, server_default=text("'[]'"))
    chronic_conditions: Mapped[list] = mapped_column(
        postgresql.JSONB, nullable=False, server_default=text("'[]'")
    )
    current_medications: Mapped[list] = mapped_column(
        postgresql.JSONB, nullable=False, server_default=text("'[]'")
    )
    emergency_contact: Mapped[dict | None] = mapped_column(postgresql.JSONB)
    preferred_language: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'en'"))

    user: Mapped["User"] = relationship(back_populates="patient_profile")
