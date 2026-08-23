"""Audit log writes -- IMPLEMENTATION.md section 6.6's audit_log table, section 16
Phase 7 "audit log coverage." Best-effort and self-contained: an audit write must
never break the action it's recording, so it commits on its own and swallows its
own failures rather than raising into the caller's flow.
"""

import uuid

import structlog
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.audit import AuditLog
from app.models.enums import UserRole

logger = structlog.get_logger(__name__)


async def record_audit(
    session: AsyncSession,
    *,
    actor_id: uuid.UUID | None,
    actor_role: UserRole | None,
    action: str,
    entity_type: str | None = None,
    entity_id: uuid.UUID | None = None,
    metadata: dict | None = None,
    ip_address: str | None = None,
) -> None:
    try:
        session.add(
            AuditLog(
                actor_id=actor_id,
                actor_role=actor_role,
                action=action,
                entity_type=entity_type,
                entity_id=entity_id,
                audit_metadata=metadata,
                ip_address=ip_address,
            )
        )
        await session.commit()
    except Exception as e:  # noqa: BLE001 -- see module docstring
        logger.error("audit_log_write_failed", action=action, error=str(e))
        await session.rollback()
