import datetime
import uuid

from pydantic import BaseModel, EmailStr

from app.schemas.doctor import WorkingHoursOut


class WorkingHoursIn(BaseModel):
    weekday: int  # 0=Monday .. 6=Sunday
    start_time: datetime.time
    end_time: datetime.time


class DoctorCreate(BaseModel):
    email: EmailStr
    full_name: str
    password: str
    phone: str | None = None
    hospital_id: uuid.UUID | None = None
    specialisation: str
    sub_specialisations: list[str] = []
    qualifications: str | None = None
    registration_no: str | None = None
    years_experience: int | None = None
    bio: str | None = None
    consultation_fee: float | None = None
    slot_duration_min: int = 20
    buffer_min: int = 0
    max_daily_appointments: int | None = None
    accepts_emergency: bool = False
    is_accepting: bool = True
    working_hours: list[WorkingHoursIn] = []


class DoctorUpdate(BaseModel):
    full_name: str | None = None
    phone: str | None = None
    hospital_id: uuid.UUID | None = None
    specialisation: str | None = None
    sub_specialisations: list[str] | None = None
    qualifications: str | None = None
    registration_no: str | None = None
    years_experience: int | None = None
    bio: str | None = None
    consultation_fee: float | None = None
    slot_duration_min: int | None = None
    buffer_min: int | None = None
    max_daily_appointments: int | None = None
    accepts_emergency: bool | None = None
    is_accepting: bool | None = None
    is_active: bool | None = None


class AdminDoctorOut(BaseModel):
    user_id: uuid.UUID
    email: str
    full_name: str
    phone: str | None
    is_active: bool
    hospital_id: uuid.UUID | None
    hospital_name: str | None
    specialisation: str
    sub_specialisations: list[str]
    qualifications: str | None
    registration_no: str | None
    years_experience: int | None
    bio: str | None
    consultation_fee: float | None
    slot_duration_min: int
    buffer_min: int
    max_daily_appointments: int | None
    accepts_emergency: bool
    is_accepting: bool
    working_hours: list[WorkingHoursOut]


class HospitalCreate(BaseModel):
    name: str
    address: str | None = None
    city: str | None = None
    phone: str | None = None
    has_emergency_dept: bool = False


class HospitalUpdate(BaseModel):
    name: str | None = None
    address: str | None = None
    city: str | None = None
    phone: str | None = None
    has_emergency_dept: bool | None = None


class LatencyStats(BaseModel):
    stage: str
    p50_ms: float | None
    p95_ms: float | None
    sample_count: int


class AdminHealthOut(BaseModel):
    outbox_backlog: dict[str, int]
    voice_sessions_total: int
    voice_sessions_emergency: int
    red_flag_fire_rate: float
    red_flag_categories: dict[str, int]
    voice_latency: list[LatencyStats]
    llm_provider_status: list[dict]
