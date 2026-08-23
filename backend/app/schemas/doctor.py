import datetime
import uuid

from pydantic import BaseModel, ConfigDict


class HospitalOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    address: str | None
    city: str | None
    phone: str | None
    has_emergency_dept: bool


class WorkingHoursOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    weekday: int
    start_time: datetime.time
    end_time: datetime.time


class DoctorOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    user_id: uuid.UUID
    full_name: str
    hospital_id: uuid.UUID | None
    specialisation: str
    sub_specialisations: list[str]
    qualifications: str | None
    years_experience: int | None
    bio: str | None
    consultation_fee: float | None
    slot_duration_min: int
    accepts_emergency: bool
    is_accepting: bool


class DoctorListItem(BaseModel):
    user_id: uuid.UUID
    full_name: str
    specialisation: str
    hospital_id: uuid.UUID | None
    hospital_name: str | None
    consultation_fee: float | None
    years_experience: int | None
    accepts_emergency: bool
    next_available: datetime.datetime | None


class AvailabilityOut(BaseModel):
    doctor_id: uuid.UUID
    slot_duration_min: int
    slots: list[datetime.datetime]
