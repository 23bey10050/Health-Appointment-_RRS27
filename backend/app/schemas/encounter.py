import datetime
import uuid

from pydantic import BaseModel, ConfigDict


class PrescriptionIn(BaseModel):
    drug_name: str
    strength: str | None = None
    form: str | None = None
    frequency_code: str  # OD | BD | TDS | QID | HS | SOS | Q6H
    relation_to_food: str | None = None
    duration_days: int
    start_date: datetime.date
    instructions: str | None = None


class PrescriptionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    drug_name: str
    strength: str | None
    form: str | None
    frequency_code: str
    relation_to_food: str | None
    duration_days: int
    start_date: datetime.date
    instructions: str | None
    is_active: bool


class EncounterCreate(BaseModel):
    appointment_id: uuid.UUID
    clinical_notes: str | None = None
    diagnosis: str | None = None
    vitals: dict | None = None
    follow_up_after_days: int | None = None
    prescriptions: list[PrescriptionIn] = []


class EncounterOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    appointment_id: uuid.UUID
    clinical_notes: str | None
    diagnosis: str | None
    vitals: dict | None
    follow_up_after_days: int | None
    submitted_at: datetime.datetime | None
    prescriptions: list[PrescriptionOut] = []
