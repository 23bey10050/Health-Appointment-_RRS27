import datetime
import uuid

from pydantic import BaseModel, ConfigDict

from app.models.enums import AppointmentKind, AppointmentStatus, UrgencyLevel


class HoldRequest(BaseModel):
    doctor_id: uuid.UUID
    start_at: datetime.datetime
    duration_min: int | None = None  # defaults to the doctor's slot_duration_min


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
