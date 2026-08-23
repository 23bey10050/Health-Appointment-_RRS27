"""Import every model module so Base.metadata is fully populated as a side effect."""

from app.db.base import Base
from app.models.appointment import Appointment
from app.models.audit import AuditLog
from app.models.doctor import DoctorLeave, DoctorProfile, DoctorWorkingHours
from app.models.emergency import EmergencyQueueEntry
from app.models.encounter import AISummary, Encounter, Prescription
from app.models.hospital import Hospital
from app.models.kb import KBChunk, KBDocument
from app.models.notification import CalendarLink, EmailOutbox, GoogleOAuthToken, MedicationReminder
from app.models.user import PatientProfile, User
from app.models.voice import VoiceSession, VoiceTurn

__all__ = [
    "Base",
    "User",
    "PatientProfile",
    "Hospital",
    "DoctorProfile",
    "DoctorWorkingHours",
    "DoctorLeave",
    "EmergencyQueueEntry",
    "Appointment",
    "Encounter",
    "Prescription",
    "AISummary",
    "VoiceSession",
    "VoiceTurn",
    "KBDocument",
    "KBChunk",
    "EmailOutbox",
    "MedicationReminder",
    "CalendarLink",
    "GoogleOAuthToken",
    "AuditLog",
]
