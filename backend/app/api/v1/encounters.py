import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import CurrentUser, require_role
from app.db.session import get_session
from app.deps import get_redis
from app.models.appointment import Appointment
from app.models.encounter import Encounter, Prescription
from app.models.enums import AppointmentStatus, UserRole
from app.schemas.encounter import EncounterCreate, EncounterOut
from app.schemas.summary import SummaryOut
from app.services.prescription import FREQUENCY_TIMES, expand_reminders
from app.services.summaries import generate_post_visit_summary

router = APIRouter(tags=["encounters"])


@router.post("/encounters", response_model=EncounterOut, status_code=status.HTTP_201_CREATED)
async def create_encounter(
    body: EncounterCreate,
    current: CurrentUser = Depends(require_role(UserRole.doctor)),
    session: AsyncSession = Depends(get_session),
) -> Encounter:
    appointment = await session.get(Appointment, body.appointment_id)
    if appointment is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Appointment not found")
    if appointment.doctor_id != current.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Not your appointment")

    existing = await session.scalar(select(Encounter).where(Encounter.appointment_id == appointment.id))
    if existing is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "An encounter already exists for this appointment")

    encounter = Encounter(
        appointment_id=appointment.id,
        clinical_notes=body.clinical_notes,
        diagnosis=body.diagnosis,
        vitals=body.vitals,
        follow_up_after_days=body.follow_up_after_days,
        submitted_at=datetime.now(UTC),
        submitted_by=current.id,
    )
    session.add(encounter)
    await session.flush()

    for p in body.prescriptions:
        prescription = Prescription(
            encounter_id=encounter.id,
            drug_name=p.drug_name,
            strength=p.strength,
            form=p.form,
            frequency_code=p.frequency_code,
            times_of_day=FREQUENCY_TIMES.get(p.frequency_code.upper(), []),
            relation_to_food=p.relation_to_food,
            duration_days=p.duration_days,
            start_date=p.start_date,
            instructions=p.instructions,
        )
        session.add(prescription)
        await session.flush()
        await expand_reminders(
            session,
            prescription_id=prescription.id,
            patient_id=appointment.patient_id,
            frequency_code=p.frequency_code,
            start_date=p.start_date,
            duration_days=p.duration_days,
        )

    if appointment.status == AppointmentStatus.confirmed:
        appointment.status = AppointmentStatus.completed
        appointment.updated_at = datetime.now(UTC)

    await session.commit()
    await session.refresh(encounter, attribute_names=["prescriptions"])
    return encounter


@router.get("/encounters/{encounter_id}", response_model=EncounterOut)
async def get_encounter(
    encounter_id: uuid.UUID,
    current: CurrentUser = Depends(require_role(UserRole.doctor, UserRole.patient, UserRole.admin)),
    session: AsyncSession = Depends(get_session),
) -> Encounter:
    encounter = await session.get(Encounter, encounter_id)
    if encounter is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Encounter not found")
    appointment = await session.get(Appointment, encounter.appointment_id)
    if current.role == UserRole.doctor and appointment.doctor_id != current.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Not your encounter")
    if current.role == UserRole.patient and appointment.patient_id != current.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Not your encounter")
    await session.refresh(encounter, attribute_names=["prescriptions"])
    return encounter


@router.post("/encounters/{encounter_id}/generate-summary", response_model=SummaryOut)
async def generate_summary(
    encounter_id: uuid.UUID,
    current: CurrentUser = Depends(require_role(UserRole.doctor)),
    session: AsyncSession = Depends(get_session),
    redis=Depends(get_redis),
):
    encounter = await session.get(Encounter, encounter_id)
    if encounter is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Encounter not found")
    appointment = await session.get(Appointment, encounter.appointment_id)
    if appointment.doctor_id != current.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Not your encounter")

    return await generate_post_visit_summary(session, redis, encounter_id)
