import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import CurrentUser, hash_password, require_role
from app.db.session import get_session
from app.llm.router import get_router
from app.models.doctor import DoctorProfile, DoctorWorkingHours
from app.models.enums import UserRole
from app.models.hospital import Hospital
from app.models.kb import KBChunk, KBDocument
from app.models.notification import EmailOutbox
from app.models.user import User
from app.models.voice import VoiceSession, VoiceTurn
from app.rag.ingest import ingest_markdown
from app.schemas.admin import (
    AdminDoctorOut,
    AdminHealthOut,
    DoctorCreate,
    DoctorUpdate,
    HospitalCreate,
    HospitalUpdate,
    LatencyStats,
    WorkingHoursIn,
)
from app.schemas.doctor import HospitalOut, WorkingHoursOut
from app.schemas.kb import KBDocumentOut, KBDocumentUpload
from app.schemas.leave import (
    AffectedAppointmentOut,
    AlternativeSlot,
    LeaveConfirmRequest,
    LeaveImpactPreview,
    LeaveOut,
    LeaveRequest,
)
from app.services.leave import handle_leave_conflicts, preview_leave_conflicts

router = APIRouter(prefix="/admin", tags=["admin"])


def _assert_leave_scope(doctor_id: uuid.UUID, current: CurrentUser) -> None:
    """Both admins and doctors may manage leave -- a doctor only for themselves.
    Leave has no separate pending/approved state in this schema (DoctorLeave),
    so a doctor "requesting" leave and an admin "approving" it are the same
    operation: preview, then confirm, which runs the full conflict-handling flow
    (services/leave.py) immediately either way."""
    if current.role == UserRole.doctor and doctor_id != current.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Doctors can only manage their own leave")


@router.post("/doctors/{doctor_id}/leave", response_model=LeaveImpactPreview)
async def preview_leave(
    doctor_id: uuid.UUID,
    body: LeaveRequest,
    current: CurrentUser = Depends(require_role(UserRole.admin, UserRole.doctor)),
    session: AsyncSession = Depends(get_session),
) -> LeaveImpactPreview:
    _assert_leave_scope(doctor_id, current)
    affected = await preview_leave_conflicts(session, doctor_id, body.start_date, body.end_date)
    return LeaveImpactPreview(
        doctor_id=doctor_id,
        start_date=body.start_date,
        end_date=body.end_date,
        affected_count=len(affected),
        affected=[
            AffectedAppointmentOut(
                appointment_id=a.appointment.id,
                patient_name=a.patient_name,
                start_at=a.appointment.start_at,
                alternatives=[AlternativeSlot(**alt) for alt in a.alternatives],
            )
            for a in affected
        ],
    )


@router.post("/doctors/{doctor_id}/leave/confirm", response_model=LeaveOut)
async def confirm_leave(
    doctor_id: uuid.UUID,
    body: LeaveConfirmRequest,
    current: CurrentUser = Depends(require_role(UserRole.admin, UserRole.doctor)),
    session: AsyncSession = Depends(get_session),
) -> LeaveOut:
    _assert_leave_scope(doctor_id, current)
    leave = await handle_leave_conflicts(
        session, doctor_id, body.start_date, body.end_date, body.reason, current.id
    )
    return LeaveOut(
        id=leave.id,
        doctor_id=leave.doctor_id,
        start_date=leave.start_date,
        end_date=leave.end_date,
        reason=leave.reason,
        affected_appointments_handled=leave.affected_appointments_handled,
    )


VALID_NAMESPACES = {"clinic_kb", "triage_kb", "clinical_kb", "patient_ctx"}
VALID_AUDIENCES = {"patient", "doctor", "both"}


@router.post("/kb/documents", response_model=KBDocumentOut, status_code=status.HTTP_201_CREATED)
async def upload_kb_document(
    body: KBDocumentUpload,
    current: CurrentUser = Depends(require_role(UserRole.admin)),
    session: AsyncSession = Depends(get_session),
) -> KBDocumentOut:
    """Markdown only -- section 8.2's chunker is structure-agnostic prose chunking,
    which is what an admin hand-authoring a policy/FAQ update actually needs. The
    structured YAML sources (triage routing, red-flag definitions, clarifying
    questions) have one hand-written converter each per exact schema
    (rag/seed_yaml.py) and are re-indexed via `POST /admin/kb/reindex-seed`, not
    free-form upload.
    """
    if body.namespace not in VALID_NAMESPACES:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"Unknown namespace '{body.namespace}'")
    if body.audience not in VALID_AUDIENCES:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"Unknown audience '{body.audience}'")
    if body.source_type != "markdown":
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Only source_type='markdown' is supported here")

    source_uri = f"admin_upload://{uuid.uuid4()}/{body.title}"
    chunk_count = await ingest_markdown(
        session,
        namespace=body.namespace,
        audience=body.audience,
        title=body.title,
        source_uri=source_uri,
        markdown_text=body.content,
    )

    document = await session.scalar(select(KBDocument).where(KBDocument.source_uri == source_uri))
    return KBDocumentOut(
        id=document.id, namespace=document.namespace, audience=document.audience, title=document.title,
        source_uri=document.source_uri, source_type=document.source_type, version=document.version,
        is_active=document.is_active, created_at=document.created_at, chunk_count=chunk_count,
    )


@router.get("/kb/documents", response_model=list[KBDocumentOut])
async def list_kb_documents(
    current: CurrentUser = Depends(require_role(UserRole.admin)),
    session: AsyncSession = Depends(get_session),
) -> list[KBDocumentOut]:
    rows = (
        await session.execute(
            select(KBDocument, func.count(KBChunk.id))
            .outerjoin(KBChunk, KBChunk.document_id == KBDocument.id)
            .group_by(KBDocument.id)
            .order_by(KBDocument.created_at.desc())
        )
    ).all()
    return [
        KBDocumentOut(
            id=doc.id, namespace=doc.namespace, audience=doc.audience, title=doc.title,
            source_uri=doc.source_uri, source_type=doc.source_type, version=doc.version,
            is_active=doc.is_active, created_at=doc.created_at, chunk_count=count,
        )
        for doc, count in rows
    ]


@router.post("/kb/reindex-seed")
async def reindex_seed(
    current: CurrentUser = Depends(require_role(UserRole.admin)),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """Re-ingests the built-in markdown + structured-YAML seed sources (section
    8.5) -- for when app/rag/seed/*.md or the YAML routing/red-flag/clarifying-
    question files change and need re-embedding without a container restart."""
    from scripts.seed_kb import MARKDOWN_SOURCES, SEED_DIR, YAML_SOURCES

    import yaml

    from app.rag.ingest import ingest_chunks

    total_chunks = 0
    documents = 0
    for filename, namespace, audience, title in MARKDOWN_SOURCES:
        text = (SEED_DIR / filename).read_text(encoding="utf-8")
        count = await ingest_markdown(
            session, namespace=namespace, audience=audience, title=title,
            source_uri=f"seed://{filename}", markdown_text=text,
        )
        total_chunks += count
        documents += 1

    for filename, namespace, audience, title, converter in YAML_SOURCES:
        entries = yaml.safe_load((SEED_DIR / filename).read_text(encoding="utf-8"))
        chunks = converter(entries)
        count = await ingest_chunks(
            session, namespace=namespace, audience=audience, title=title,
            source_uri=f"seed://{filename}", source_type="yaml", chunks=chunks,
        )
        total_chunks += count
        documents += 1

    return {"documents_reindexed": documents, "total_chunks": total_chunks}


# ---------------------------------------------------------------------------
# Hospitals
# ---------------------------------------------------------------------------


@router.post("/hospitals", response_model=HospitalOut, status_code=status.HTTP_201_CREATED)
async def create_hospital(
    body: HospitalCreate,
    current: CurrentUser = Depends(require_role(UserRole.admin)),
    session: AsyncSession = Depends(get_session),
) -> Hospital:
    hospital = Hospital(**body.model_dump())
    session.add(hospital)
    await session.commit()
    await session.refresh(hospital)
    return hospital


@router.patch("/hospitals/{hospital_id}", response_model=HospitalOut)
async def update_hospital(
    hospital_id: uuid.UUID,
    body: HospitalUpdate,
    current: CurrentUser = Depends(require_role(UserRole.admin)),
    session: AsyncSession = Depends(get_session),
) -> Hospital:
    hospital = await session.get(Hospital, hospital_id)
    if hospital is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Hospital not found")
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(hospital, field, value)
    await session.commit()
    await session.refresh(hospital)
    return hospital


# ---------------------------------------------------------------------------
# Doctors
# ---------------------------------------------------------------------------


async def _to_admin_doctor_out(session: AsyncSession, profile: DoctorProfile, user: User) -> AdminDoctorOut:
    hospital_name = None
    if profile.hospital_id:
        hospital_name = await session.scalar(select(Hospital.name).where(Hospital.id == profile.hospital_id))
    hours = (
        await session.scalars(
            select(DoctorWorkingHours)
            .where(DoctorWorkingHours.doctor_id == profile.user_id)
            .order_by(DoctorWorkingHours.weekday, DoctorWorkingHours.start_time)
        )
    ).all()
    return AdminDoctorOut(
        user_id=profile.user_id, email=user.email, full_name=user.full_name, phone=user.phone,
        is_active=user.is_active, hospital_id=profile.hospital_id, hospital_name=hospital_name,
        specialisation=profile.specialisation, sub_specialisations=profile.sub_specialisations,
        qualifications=profile.qualifications, registration_no=profile.registration_no,
        years_experience=profile.years_experience, bio=profile.bio, consultation_fee=profile.consultation_fee,
        slot_duration_min=profile.slot_duration_min, buffer_min=profile.buffer_min,
        max_daily_appointments=profile.max_daily_appointments, accepts_emergency=profile.accepts_emergency,
        is_accepting=profile.is_accepting,
        working_hours=[WorkingHoursOut.model_validate(h) for h in hours],
    )


@router.get("/doctors", response_model=list[AdminDoctorOut])
async def list_admin_doctors(
    current: CurrentUser = Depends(require_role(UserRole.admin)),
    session: AsyncSession = Depends(get_session),
) -> list[AdminDoctorOut]:
    rows = (
        await session.execute(
            select(DoctorProfile, User).join(User, User.id == DoctorProfile.user_id).order_by(User.full_name)
        )
    ).all()
    return [await _to_admin_doctor_out(session, profile, user) for profile, user in rows]


@router.get("/doctors/{doctor_id}", response_model=AdminDoctorOut)
async def get_admin_doctor(
    doctor_id: uuid.UUID,
    current: CurrentUser = Depends(require_role(UserRole.admin)),
    session: AsyncSession = Depends(get_session),
) -> AdminDoctorOut:
    profile = await session.get(DoctorProfile, doctor_id)
    if profile is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Doctor not found")
    user = await session.get(User, doctor_id)
    return await _to_admin_doctor_out(session, profile, user)


@router.post("/doctors", response_model=AdminDoctorOut, status_code=status.HTTP_201_CREATED)
async def create_doctor(
    body: DoctorCreate,
    current: CurrentUser = Depends(require_role(UserRole.admin)),
    session: AsyncSession = Depends(get_session),
) -> AdminDoctorOut:
    existing = await session.scalar(select(User).where(User.email == body.email))
    if existing is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "An account with this email already exists")

    user = User(
        email=body.email, full_name=body.full_name, phone=body.phone,
        password_hash=hash_password(body.password), role=UserRole.doctor,
    )
    session.add(user)
    await session.flush()

    profile = DoctorProfile(
        user_id=user.id, hospital_id=body.hospital_id, specialisation=body.specialisation,
        sub_specialisations=body.sub_specialisations, qualifications=body.qualifications,
        registration_no=body.registration_no, years_experience=body.years_experience, bio=body.bio,
        consultation_fee=body.consultation_fee, slot_duration_min=body.slot_duration_min,
        buffer_min=body.buffer_min, max_daily_appointments=body.max_daily_appointments,
        accepts_emergency=body.accepts_emergency, is_accepting=body.is_accepting,
    )
    session.add(profile)
    for wh in body.working_hours:
        session.add(DoctorWorkingHours(doctor_id=user.id, **wh.model_dump()))
    await session.commit()

    return await _to_admin_doctor_out(session, profile, user)


@router.patch("/doctors/{doctor_id}", response_model=AdminDoctorOut)
async def update_doctor(
    doctor_id: uuid.UUID,
    body: DoctorUpdate,
    current: CurrentUser = Depends(require_role(UserRole.admin)),
    session: AsyncSession = Depends(get_session),
) -> AdminDoctorOut:
    profile = await session.get(DoctorProfile, doctor_id)
    if profile is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Doctor not found")
    user = await session.get(User, doctor_id)

    updates = body.model_dump(exclude_unset=True)
    if "full_name" in updates:
        user.full_name = updates.pop("full_name")
    if "phone" in updates:
        user.phone = updates.pop("phone")
    if "is_active" in updates:
        user.is_active = updates.pop("is_active")
    for field, value in updates.items():
        setattr(profile, field, value)

    await session.commit()
    return await _to_admin_doctor_out(session, profile, user)


@router.put("/doctors/{doctor_id}/working-hours", response_model=list[WorkingHoursOut])
async def replace_working_hours(
    doctor_id: uuid.UUID,
    body: list[WorkingHoursIn],
    current: CurrentUser = Depends(require_role(UserRole.admin)),
    session: AsyncSession = Depends(get_session),
) -> list[DoctorWorkingHours]:
    profile = await session.get(DoctorProfile, doctor_id)
    if profile is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Doctor not found")

    existing = (
        await session.scalars(select(DoctorWorkingHours).where(DoctorWorkingHours.doctor_id == doctor_id))
    ).all()
    for row in existing:
        await session.delete(row)
    await session.flush()

    new_rows = [DoctorWorkingHours(doctor_id=doctor_id, **wh.model_dump()) for wh in body]
    session.add_all(new_rows)
    await session.commit()
    for row in new_rows:
        await session.refresh(row)
    return sorted(new_rows, key=lambda r: (r.weekday, r.start_time))


# ---------------------------------------------------------------------------
# System health
# ---------------------------------------------------------------------------


def _percentiles(values: list[float]) -> tuple[float | None, float | None]:
    if not values:
        return None, None
    ordered = sorted(values)

    def pct(p: float) -> float:
        idx = min(len(ordered) - 1, int(len(ordered) * p))
        return ordered[idx]

    return pct(0.5), pct(0.95)


@router.get("/health", response_model=AdminHealthOut)
async def admin_health(
    current: CurrentUser = Depends(require_role(UserRole.admin)),
    session: AsyncSession = Depends(get_session),
) -> AdminHealthOut:
    outbox_rows = (
        await session.execute(select(EmailOutbox.status, func.count()).group_by(EmailOutbox.status))
    ).all()
    outbox_backlog = {status_val.value: count for status_val, count in outbox_rows}

    total_sessions = await session.scalar(select(func.count()).select_from(VoiceSession)) or 0
    emergency_sessions = (
        await session.scalar(select(func.count()).select_from(VoiceSession).where(VoiceSession.emergency_triggered.is_(True)))
        or 0
    )
    fire_rate = (emergency_sessions / total_sessions) if total_sessions else 0.0

    category_counts: dict[str, int] = {}
    flagged = await session.scalars(
        select(VoiceSession.red_flags_matched).where(VoiceSession.emergency_triggered.is_(True))
    )
    for flags in flagged:
        for f in flags:
            category_counts[f] = category_counts.get(f, 0) + 1

    recent_turns = (
        await session.scalars(
            select(VoiceTurn.latency_ms)
            .where(VoiceTurn.latency_ms.is_not(None))
            .order_by(VoiceTurn.created_at.desc())
            .limit(500)
        )
    ).all()
    by_stage: dict[str, list[float]] = {}
    for row in recent_turns:
        for stage, ms in (row or {}).items():
            by_stage.setdefault(stage, []).append(float(ms))

    voice_latency = []
    for stage, values in by_stage.items():
        p50, p95 = _percentiles(values)
        voice_latency.append(LatencyStats(stage=stage, p50_ms=p50, p95_ms=p95, sample_count=len(values)))

    return AdminHealthOut(
        outbox_backlog=outbox_backlog,
        voice_sessions_total=total_sessions,
        voice_sessions_emergency=emergency_sessions,
        red_flag_fire_rate=round(fire_rate, 4),
        red_flag_categories=category_counts,
        voice_latency=sorted(voice_latency, key=lambda s: s.stage),
        llm_provider_status=get_router().status(),
    )
