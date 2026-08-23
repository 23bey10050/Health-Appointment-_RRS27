import datetime
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_session
from app.models.doctor import DoctorProfile
from app.models.hospital import Hospital
from app.models.user import User
from app.schemas.doctor import AvailabilityOut, DoctorListItem, DoctorOut, HospitalOut
from app.services.availability import compute_availability

router = APIRouter(tags=["doctors"])

NEXT_AVAILABLE_WINDOW_DAYS = 5


@router.get("/hospitals", response_model=list[HospitalOut])
async def list_hospitals(
    city: str | None = None,
    has_emergency_dept: bool | None = None,
    session: AsyncSession = Depends(get_session),
) -> list[Hospital]:
    stmt = select(Hospital)
    if city:
        stmt = stmt.where(Hospital.city == city)
    if has_emergency_dept is not None:
        stmt = stmt.where(Hospital.has_emergency_dept == has_emergency_dept)
    return list(await session.scalars(stmt.order_by(Hospital.name)))


@router.get("/specialisations", response_model=list[str])
async def list_specialisations(session: AsyncSession = Depends(get_session)) -> list[str]:
    rows = await session.scalars(
        select(DoctorProfile.specialisation).distinct().order_by(DoctorProfile.specialisation)
    )
    return list(rows)


@router.get("/doctors", response_model=list[DoctorListItem])
async def list_doctors(
    specialisation: str | None = None,
    hospital_id: uuid.UUID | None = None,
    date: datetime.date | None = None,
    q: str | None = Query(None, description="Free-text search over doctor name and specialisation"),
    session: AsyncSession = Depends(get_session),
) -> list[DoctorListItem]:
    stmt = (
        select(DoctorProfile, User.full_name, Hospital.name)
        .join(User, User.id == DoctorProfile.user_id)
        .outerjoin(Hospital, Hospital.id == DoctorProfile.hospital_id)
        .where(DoctorProfile.is_accepting.is_(True))
    )
    if specialisation:
        stmt = stmt.where(DoctorProfile.specialisation.ilike(specialisation))
    if hospital_id:
        stmt = stmt.where(DoctorProfile.hospital_id == hospital_id)
    if q:
        like = f"%{q}%"
        stmt = stmt.where(User.full_name.ilike(like) | DoctorProfile.specialisation.ilike(like))

    rows = (await session.execute(stmt.order_by(User.full_name))).all()

    window_from = date or datetime.date.today()
    window_to = window_from + datetime.timedelta(days=NEXT_AVAILABLE_WINDOW_DAYS)

    results: list[DoctorListItem] = []
    for profile, full_name, hospital_name in rows:
        slots = await compute_availability(session, profile.user_id, window_from, window_to)
        if date is not None and not slots:
            continue  # explicit date filter: only show doctors with an opening that day
        results.append(
            DoctorListItem(
                user_id=profile.user_id,
                full_name=full_name,
                specialisation=profile.specialisation,
                hospital_id=profile.hospital_id,
                hospital_name=hospital_name,
                consultation_fee=profile.consultation_fee,
                years_experience=profile.years_experience,
                accepts_emergency=profile.accepts_emergency,
                next_available=slots[0] if slots else None,
            )
        )
    return results


@router.get("/doctors/{doctor_id}", response_model=DoctorOut)
async def get_doctor(doctor_id: uuid.UUID, session: AsyncSession = Depends(get_session)) -> DoctorOut:
    profile = await session.get(DoctorProfile, doctor_id)
    if profile is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Doctor not found")
    user = await session.get(User, doctor_id)
    return DoctorOut(
        user_id=profile.user_id,
        full_name=user.full_name if user else "",
        hospital_id=profile.hospital_id,
        specialisation=profile.specialisation,
        sub_specialisations=profile.sub_specialisations,
        qualifications=profile.qualifications,
        years_experience=profile.years_experience,
        bio=profile.bio,
        consultation_fee=profile.consultation_fee,
        slot_duration_min=profile.slot_duration_min,
        accepts_emergency=profile.accepts_emergency,
        is_accepting=profile.is_accepting,
    )


@router.get("/doctors/{doctor_id}/availability", response_model=AvailabilityOut)
async def get_doctor_availability(
    doctor_id: uuid.UUID,
    date_from: datetime.date,
    date_to: datetime.date,
    session: AsyncSession = Depends(get_session),
) -> AvailabilityOut:
    if date_to < date_from:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "date_to must be on or after date_from")
    if (date_to - date_from).days > 31:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Range too wide -- max 31 days")

    profile = await session.get(DoctorProfile, doctor_id)
    if profile is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Doctor not found")

    slots = await compute_availability(session, doctor_id, date_from, date_to)
    return AvailabilityOut(doctor_id=doctor_id, slot_duration_min=profile.slot_duration_min, slots=slots)
