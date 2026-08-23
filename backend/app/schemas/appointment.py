import datetime
import uuid

from pydantic import BaseModel, ConfigDict, Field

from app.models.enums import AppointmentKind, AppointmentStatus, UrgencyLevel


class HoldRequest(BaseModel):
    doctor_id: uuid.UUID
    start_at: datetime.datetime
    duration_min: int | None = None  # defaults to the doctor's slot_duration_min


class SymptomIntake(BaseModel):
    """The symptom form a patient fills in before confirming a booking.

    Mirrors what the voice agent gathers conversationally, so both booking
    channels feed generate_pre_visit_summary the same quality of input. Without
    this the web path had nothing but the patient's stored profile, and the
    doctor's pre-visit panel came out effectively blank.
    """

    symptoms: str = Field(min_length=3, max_length=2000)
    duration: str | None = Field(default=None, max_length=120)
    severity: int | None = Field(default=None, ge=1, le=10)
    existing_conditions: str | None = Field(default=None, max_length=1000)
    current_medications: str | None = Field(default=None, max_length=1000)
    allergies: str | None = Field(default=None, max_length=1000)

    def to_reason_text(self) -> str:
        """Flatten to the free text generate_pre_visit_summary already reads."""
        parts = [f"Symptoms: {self.symptoms.strip()}"]
        if self.duration:
            parts.append(f"Duration: {self.duration.strip()}")
        if self.severity is not None:
            parts.append(f"Severity (self-reported, 1-10): {self.severity}")
        if self.existing_conditions:
            parts.append(f"Existing conditions: {self.existing_conditions.strip()}")
        if self.current_medications:
            parts.append(f"Current medications: {self.current_medications.strip()}")
        if self.allergies:
            parts.append(f"Allergies: {self.allergies.strip()}")
        return "\n".join(parts)


class ConfirmRequest(BaseModel):
    """Symptom intake is optional at the API layer so an already-confirmed hold
    stays idempotent and the voice path (which has a transcript instead) can
    reuse this endpoint."""

    symptom_intake: SymptomIntake | None = None


class RescheduleRequest(BaseModel):
    new_start_at: datetime.datetime


class CancelRequest(BaseModel):
    reason: str | None = None


class AppointmentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    doctor_id: uuid.UUID
    doctor_name: str | None = None
    patient_id: uuid.UUID
    patient_name: str | None = None
    hospital_id: uuid.UUID | None
    start_at: datetime.datetime
    end_at: datetime.datetime
    status: AppointmentStatus
    kind: AppointmentKind
    urgency: UrgencyLevel | None
    booking_channel: str
    reason_text: str | None
    hold_expires_at: datetime.datetime | None
    cancellation_reason: str | None
    created_at: datetime.datetime
