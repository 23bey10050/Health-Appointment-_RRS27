import uuid
from datetime import datetime

from sqlalchemy import BigInteger, ForeignKey, Text, func
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models._types import pg_enum
from app.models.enums import UserRole


class AuditLog(Base):
    __tablename__ = "audit_log"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    actor_id: Mapped[uuid.UUID | None] = mapped_column(
        postgresql.UUID(as_uuid=True), ForeignKey("users.id")
    )
    actor_role: Mapped[UserRole | None] = mapped_column(pg_enum(UserRole, "user_role"))
    action: Mapped[str] = mapped_column(Text, nullable=False)
    entity_type: Mapped[str | None] = mapped_column(Text)
    entity_id: Mapped[uuid.UUID | None] = mapped_column(postgresql.UUID(as_uuid=True))
    audit_metadata: Mapped[dict | None] = mapped_column("metadata", postgresql.JSONB)
    ip_address: Mapped[str | None] = mapped_column(postgresql.INET)
    created_at: Mapped[datetime] = mapped_column(
        postgresql.TIMESTAMP(timezone=True), nullable=False, server_default=func.now()
    )
