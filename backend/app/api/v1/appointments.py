import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.core.security import CurrentUser, get_current_user, require_role
from app.db.session import get_session
from app.models.appointment import Appointment
from app.models.doctor import DoctorProfile
from app.models.encounter import AISummary, Encounter
from app.models.enums import SummaryKind, UserRole
from app.models.user import User
from app.schemas.appointment import (
    AppointmentOut,
    CancelRequest,
    ConfirmRequest,
    HoldRequest,
    RescheduleRequest,
)
from app.schemas.encounter import EncounterOut
from app.schemas.summary import SummaryOut
from app.services.booking import cancel_appointment, confirm_booking, hold_slot, reschedule_appointment

router = APIRouter(prefix="/appointments", tags=["appointments"])


async def _get_owned_or_404(session: AsyncSession, appointment_id: uuid.UUID, current: CurrentUser) -> Appointment:
    appt = await session.get(Appointment, appointment_id)
    if appt is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Appointment not found")
    if current.role == UserRole.patient and appt.patient_id != current.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Not your appointment")
    if current.role == UserRole.doctor and appt.doctor_id != current.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Not your appointment")
    return appt


@router.post("/hold", response_model=AppointmentOut, status_code=status.HTTP_201_CREATED)
async def hold(
    body: HoldRequest,
    current: CurrentUser = Depends(require_role(UserRole.patient, UserRole.admin)),
    session: AsyncSession = Depends(get_session),
) -> Appointment:
    doctor = await session.get(DoctorProfile, body.doctor_id)
    if doctor is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Doctor not found")
    duration_min = body.duration_min or doctor.slot_duration_min
    return await hold_slot(session, body.doctor_id, current.id, body.start_at, duration_min)


@router.post("/{appointment_id}/confirm", response_model=AppointmentOut)
async def confirm(
    appointment_id: uuid.UUID,
    payload: ConfirmRequest | None = None,
    current: CurrentUser = Depends(require_role(UserRole.patient)),
    session: AsyncSession = Depends(get_session),
) -> Appointment:
    intake = payload.symptom_intake if payload else None
    return await confirm_booking(
        session, appointment_id, current.id, reason_text=intake.to_reason_text() if intake else None
    )


def _with_names(appt: Appointment, doctor_name: str, patient_name: str) -> AppointmentOut:
    return AppointmentOut.model_validate(appt).model_copy(
        update={"doctor_name": doctor_name, "patient_name": patient_name}
    )


@router.get("", response_model=list[AppointmentOut])
async def list_appointments(
    current: CurrentUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> list[AppointmentOut]:
    DoctorUser = aliased(User)
    PatientUser = aliased(User)
    stmt = (
        select(Appointment, DoctorUser.full_name, PatientUser.full_name)
        .join(DoctorUser, DoctorUser.id == Appointment.doctor_id)
        .join(PatientUser, PatientUser.id == Appointment.patient_id)
        .order_by(Appointment.start_at.desc())
    )
    if current.role == UserRole.patient:
        stmt = stmt.where(Appointment.patient_id == current.id)
    elif current.role == UserRole.doctor:
        stmt = stmt.where(Appointment.doctor_id == current.id)
    # admin: unfiltered
    rows = (await session.execute(stmt)).all()
    return [_with_names(appt, doctor_name, patient_name) for appt, doctor_name, patient_name in rows]


@router.get("/{appointment_id}", response_model=AppointmentOut)
async def get_appointment(
    appointment_id: uuid.UUID,
    current: CurrentUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> AppointmentOut:
    appt = await _get_owned_or_404(session, appointment_id, current)
    doctor_name = await session.scalar(select(User.full_name).where(User.id == appt.doctor_id))
    patient_name = await session.scalar(select(User.full_name).where(User.id == appt.patient_id))
    return _with_names(appt, doctor_name or "", patient_name or "")


@router.post("/{appointment_id}/cancel", response_model=AppointmentOut)
async def cancel(
    appointment_id: uuid.UUID,
    body: CancelRequest,
    current: CurrentUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> Appointment:
    await _get_owned_or_404(session, appointment_id, current)
    return await cancel_appointment(session, appointment_id, current.id, body.reason)


@router.post("/{appointment_id}/reschedule", response_model=AppointmentOut)
async def reschedule(
    appointment_id: uuid.UUID,
    body: RescheduleRequest,
    current: CurrentUser = Depends(require_role(UserRole.patient, UserRole.admin)),
    session: AsyncSession = Depends(get_session),
) -> Appointment:
    await _get_owned_or_404(session, appointment_id, current)
    return await reschedule_appointment(session, appointment_id, current.id, body.new_start_at)


@router.get("/{appointment_id}/pre-visit-summary", response_model=SummaryOut)
async def get_pre_visit_summary(
    appointment_id: uuid.UUID,
    current: CurrentUser = Depends(require_role(UserRole.doctor)),
    session: AsyncSession = Depends(get_session),
) -> AISummary:
    appt = await _get_owned_or_404(session, appointment_id, current)
    summary = await session.scalar(
        select(AISummary)
        .where(AISummary.appointment_id == appt.id, AISummary.kind == SummaryKind.pre_visit)
        .order_by(AISummary.created_at.desc())
    )
    if summary is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            "No pre-visit summary yet -- generated automatically within 10 minutes of booking.",
        )
    return summary


@router.get("/{appointment_id}/post-visit-summary", response_model=SummaryOut)
async def get_post_visit_summary(
    appointment_id: uuid.UUID,
    current: CurrentUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> AISummary:
    appt = await _get_owned_or_404(session, appointment_id, current)
    summary = await session.scalar(
        select(AISummary)
        .where(AISummary.appointment_id == appt.id, AISummary.kind == SummaryKind.post_visit)
        .order_by(AISummary.created_at.desc())
    )
    if summary is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No post-visit summary yet.")
    if current.role == UserRole.patient and summary.state.value not in ("approved", "edited"):
        # SAFETY-3: a patient must never see AI-generated clinical content before
        # a doctor has approved it -- draft/failed/rejected states are invisible here.
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No post-visit summary yet.")
    return summary


@router.get("/{appointment_id}/encounter", response_model=EncounterOut)
async def get_encounter_for_appointment(
    appointment_id: uuid.UUID,
    current: CurrentUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> Encounter:
    appt = await _get_owned_or_404(session, appointment_id, current)
    encounter = await session.scalar(select(Encounter).where(Encounter.appointment_id == appt.id))
    if encounter is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No encounter recorded for this appointment yet.")
    await session.refresh(encounter, attribute_names=["prescriptions"])
    return encounter
