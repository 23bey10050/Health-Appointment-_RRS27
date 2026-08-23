"""Doctor/admin-facing emergency queue -- IMPLEMENTATION.md section 9.2 step 6
("notify on-call doctor: email + in-portal") and section 15's doctor portal
requirement for "emergency decision-support view with acknowledgement gate."

The email side of step 6 happens in safety/escalation.py at escalation time;
this module is the "in-portal" half -- the list a doctor sees on login and the
acknowledge/resolve actions that gate an emergency out of the active queue.
"""

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import CurrentUser, require_role
from app.db.session import get_session
from app.models.doctor import DoctorProfile
from app.models.emergency import EmergencyQueueEntry, EmergencyQueueStatus
from app.models.encounter import AISummary
from app.models.enums import SummaryKind, UserRole
from app.models.user import User
from app.schemas.emergency import EmergencyQueueOut
from app.services.audit import record_audit

router = APIRouter(prefix="/emergency-queue", tags=["emergency"])


async def _doctor_hospital_id(session: AsyncSession, doctor_id: uuid.UUID) -> uuid.UUID | None:
    return await session.scalar(select(DoctorProfile.hospital_id).where(DoctorProfile.user_id == doctor_id))


async def _to_out(session: AsyncSession, entry: EmergencyQueueEntry) -> EmergencyQueueOut:
    patient = await session.get(User, entry.patient_id) if entry.patient_id else None
    brief = await session.scalar(
        select(AISummary)
        .where(AISummary.emergency_queue_id == entry.id, AISummary.kind == SummaryKind.emergency_brief)
        .order_by(AISummary.created_at.desc())
        .limit(1)
    )
    return EmergencyQueueOut(
        id=entry.id,
        patient_id=entry.patient_id,
        patient_name=patient.full_name if patient else None,
        hospital_id=entry.hospital_id,
        category=entry.category,
        severity=entry.severity,
        summary=entry.summary,
        status=entry.status,
        oncall_doctor_id=entry.oncall_doctor_id,
        created_at=entry.created_at,
        acknowledged_at=entry.acknowledged_at,
        resolved_at=entry.resolved_at,
        ambulance_required=entry.ambulance_required,
        callback_name=entry.callback_name,
        callback_phone=entry.callback_phone,
        appointment_id=entry.appointment_id,
        brief=(brief.content_edited or brief.content) if brief else None,
        brief_state=brief.state if brief else None,
    )


async def _get_entry_in_scope(session: AsyncSession, entry_id: uuid.UUID, current: CurrentUser) -> EmergencyQueueEntry:
    entry = await session.get(EmergencyQueueEntry, entry_id)
    if entry is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Emergency case not found")
    if current.role == UserRole.doctor:
        if entry.oncall_doctor_id == current.id:
            return entry
        hospital_id = await _doctor_hospital_id(session, current.id)
        if hospital_id is None or entry.hospital_id != hospital_id:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Not your hospital's case")
    return entry


@router.get("", response_model=list[EmergencyQueueOut])
async def list_emergency_queue(
    current: CurrentUser = Depends(require_role(UserRole.doctor, UserRole.admin)),
    session: AsyncSession = Depends(get_session),
) -> list[EmergencyQueueOut]:
    stmt = select(EmergencyQueueEntry).order_by(EmergencyQueueEntry.created_at.desc())
    if current.role == UserRole.doctor:
        hospital_id = await _doctor_hospital_id(session, current.id)
        # A case can carry hospital_id=None (escalation.record_emergency pages
        # *some* accepting doctor when the conversation never resolved a hospital)
        # yet still name this doctor as oncall_doctor_id -- they must see it
        # regardless of the hospital-scoped filter below.
        scope = EmergencyQueueEntry.oncall_doctor_id == current.id
        if hospital_id is not None:
            scope = scope | (EmergencyQueueEntry.hospital_id == hospital_id)
        stmt = stmt.where(scope)
    entries = (await session.scalars(stmt)).all()
    return [await _to_out(session, e) for e in entries]


@router.post("/{entry_id}/acknowledge", response_model=EmergencyQueueOut)
async def acknowledge(
    entry_id: uuid.UUID,
    current: CurrentUser = Depends(require_role(UserRole.doctor, UserRole.admin)),
    session: AsyncSession = Depends(get_session),
) -> EmergencyQueueOut:
    entry = await _get_entry_in_scope(session, entry_id, current)
    if entry.status == EmergencyQueueStatus.active:
        entry.status = EmergencyQueueStatus.acknowledged
        entry.acknowledged_at = datetime.now(UTC)
        await session.commit()
        await session.refresh(entry)
        await record_audit(
            session, actor_id=current.id, actor_role=current.role, action="emergency_acknowledge",
            entity_type="emergency_queue", entity_id=entry_id,
        )
    return await _to_out(session, entry)


@router.post("/{entry_id}/resolve", response_model=EmergencyQueueOut)
async def resolve(
    entry_id: uuid.UUID,
    current: CurrentUser = Depends(require_role(UserRole.doctor, UserRole.admin)),
    session: AsyncSession = Depends(get_session),
) -> EmergencyQueueOut:
    entry = await _get_entry_in_scope(session, entry_id, current)
    entry.status = EmergencyQueueStatus.resolved
    entry.resolved_at = datetime.now(UTC)
    if entry.acknowledged_at is None:
        entry.acknowledged_at = datetime.now(UTC)
    await session.commit()
    await session.refresh(entry)
    await record_audit(
        session, actor_id=current.id, actor_role=current.role, action="emergency_resolve",
        entity_type="emergency_queue", entity_id=entry_id,
    )
    return await _to_out(session, entry)
