import datetime
import uuid

from pydantic import BaseModel, ConfigDict

from app.models.enums import SummaryKind, SummaryState


class SummaryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    kind: SummaryKind
    appointment_id: uuid.UUID | None
    encounter_id: uuid.UUID | None
    state: SummaryState
    content: dict
    content_edited: dict | None
    model_provider: str | None
    model_name: str | None
    prompt_version: str | None
    generation_error: str | None
    reviewed_by: uuid.UUID | None
    reviewed_at: datetime.datetime | None
    created_at: datetime.datetime


class SummaryApproveRequest(BaseModel):
    edited_content: dict | None = None
