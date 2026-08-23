import datetime
import uuid

from pydantic import BaseModel, ConfigDict


class KBDocumentUpload(BaseModel):
    namespace: str  # clinic_kb | triage_kb | clinical_kb
    audience: str  # patient | doctor | both
    title: str
    source_type: str = "markdown"  # markdown | yaml
    content: str  # raw markdown text, or raw YAML text for yaml source_type


class KBDocumentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    namespace: str
    audience: str
    title: str
    source_uri: str | None
    source_type: str | None
    version: int
    is_active: bool
    created_at: datetime.datetime
    chunk_count: int
