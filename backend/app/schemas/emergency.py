import datetime
import uuid

from pydantic import BaseModel

from app.models.emergency import EmergencyQueueStatus
from app.models.enums import SummaryState


class EmergencyQueueOut(BaseModel):
    id: uuid.UUID
    patient_id: uuid.UUID | None
    patient_name: str | None
    hospital_id: uuid.UUID | None
    category: str
    severity: str
    summary: str | None
    status: EmergencyQueueStatus
    oncall_doctor_id: uuid.UUID | None
    created_at: datetime.datetime
    acknowledged_at: datetime.datetime | None
    resolved_at: datetime.datetime | None
    # Captured by the voice agent's emergency intake after escalation.
    ambulance_required: bool | None
    callback_name: str | None
    callback_phone: str | None
    appointment_id: uuid.UUID | None
    # The emergency_brief AISummary content, if the REASON-tier generation
    # succeeded -- SAFETY-4: decision support fields only, never a diagnosis.
    brief: dict | None = None
    brief_state: SummaryState | None = None
