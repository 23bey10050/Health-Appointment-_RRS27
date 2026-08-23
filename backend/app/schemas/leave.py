import datetime
import uuid

from pydantic import BaseModel


class LeaveRequest(BaseModel):
    start_date: datetime.date
    end_date: datetime.date
    reason: str | None = None


class AlternativeSlot(BaseModel):
    doctor_id: uuid.UUID
    doctor_name: str
    start_at: str


class AffectedAppointmentOut(BaseModel):
    appointment_id: uuid.UUID
    patient_name: str
    start_at: datetime.datetime
    alternatives: list[AlternativeSlot]


class LeaveImpactPreview(BaseModel):
    doctor_id: uuid.UUID
    start_date: datetime.date
    end_date: datetime.date
    affected_count: int
    affected: list[AffectedAppointmentOut]


class LeaveConfirmRequest(BaseModel):
    start_date: datetime.date
    end_date: datetime.date
    reason: str | None = None


class LeaveOut(BaseModel):
    id: uuid.UUID
    doctor_id: uuid.UUID
    start_date: datetime.date
    end_date: datetime.date
    reason: str | None
    affected_appointments_handled: bool
