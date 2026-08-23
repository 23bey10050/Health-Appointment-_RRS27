import enum


class UserRole(str, enum.Enum):
    patient = "patient"
    doctor = "doctor"
    admin = "admin"


class AppointmentStatus(str, enum.Enum):
    held = "held"
    confirmed = "confirmed"
    cancelled = "cancelled"
    completed = "completed"
    no_show = "no_show"
    rescheduled = "rescheduled"


class AppointmentKind(str, enum.Enum):
    routine = "routine"
    follow_up = "follow_up"
    emergency = "emergency"


class UrgencyLevel(str, enum.Enum):
    low = "low"
    medium = "medium"
    high = "high"
    critical = "critical"


class SummaryKind(str, enum.Enum):
    pre_visit = "pre_visit"
    post_visit = "post_visit"
    emergency_brief = "emergency_brief"


class SummaryState(str, enum.Enum):
    draft = "draft"
    approved = "approved"
    edited = "edited"
    rejected = "rejected"
    failed = "failed"


class KBNamespace(str, enum.Enum):
    clinic_kb = "clinic_kb"
    triage_kb = "triage_kb"
    clinical_kb = "clinical_kb"
    patient_ctx = "patient_ctx"


class KBAudience(str, enum.Enum):
    patient = "patient"
    doctor = "doctor"
    both = "both"


class OutboxStatus(str, enum.Enum):
    pending = "pending"
    sending = "sending"
    sent = "sent"
    failed = "failed"
    dead = "dead"
