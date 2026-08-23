import uuid

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import CurrentUser, require_role
from app.db.session import get_session
from app.models.enums import UserRole
from app.schemas.summary import SummaryApproveRequest, SummaryOut
from app.services.audit import record_audit
from app.services.summaries import approve_summary, reject_summary

router = APIRouter(prefix="/summaries", tags=["summaries"])


@router.post("/{summary_id}/approve", response_model=SummaryOut)
async def approve(
    summary_id: uuid.UUID,
    body: SummaryApproveRequest,
    current: CurrentUser = Depends(require_role(UserRole.doctor)),
    session: AsyncSession = Depends(get_session),
):
    result = await approve_summary(session, summary_id, current.id, body.edited_content)
    # SAFETY-3: this is the gate that lets AI-generated clinical content reach a
    # patient -- who approved it, and when, must be reconstructable later.
    await record_audit(
        session, actor_id=current.id, actor_role=current.role, action="summary_approve",
        entity_type="ai_summary", entity_id=summary_id, metadata={"kind": result.kind.value},
    )
    return result


@router.post("/{summary_id}/reject", response_model=SummaryOut)
async def reject(
    summary_id: uuid.UUID,
    current: CurrentUser = Depends(require_role(UserRole.doctor)),
    session: AsyncSession = Depends(get_session),
):
    result = await reject_summary(session, summary_id, current.id)
    await record_audit(
        session, actor_id=current.id, actor_role=current.role, action="summary_reject",
        entity_type="ai_summary", entity_id=summary_id, metadata={"kind": result.kind.value},
    )
    return result
