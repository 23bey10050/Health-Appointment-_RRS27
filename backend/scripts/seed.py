"""Phase 0 seed data: 1 admin, 3 hospitals, 8 doctors across 6 specialisations
(with working hours), 5 patients. Idempotent -- safe to run against a DB that
already has this data (matches on email / hospital name and skips).

Run inside the api container: `python -m scripts.seed`
"""

import asyncio
import datetime as dt

from sqlalchemy import select

from app.core.security import hash_password
from app.db.session import SessionLocal
from app.models.doctor import DoctorProfile, DoctorWorkingHours
from app.models.enums import UserRole
from app.models.hospital import Hospital
from app.models.user import PatientProfile, User

DEV_PASSWORD = "DevPass123!"

HOSPITALS = [
    {"name": "City Care Main Hospital", "city": "Bengaluru", "address": "100 MG Road", "phone": "080-1000-1000", "has_emergency_dept": True},
    {"name": "City Care North Clinic", "city": "Bengaluru", "address": "45 Hebbal Ring Road", "phone": "080-1000-2000", "has_emergency_dept": False},
    {"name": "City Care South Hospital", "city": "Bengaluru", "address": "78 Bannerghatta Road", "phone": "080-1000-3000", "has_emergency_dept": True},
]

DOCTORS = [
    {"full_name": "Dr. Anjali Mehta", "email": "anjali.mehta@citycare.example", "specialisation": "General Medicine", "hospital": 0, "years": 12, "fee": 500, "accepts_emergency": True},
    {"full_name": "Dr. Rohan Kulkarni", "email": "rohan.kulkarni@citycare.example", "specialisation": "General Medicine", "hospital": 1, "years": 6, "fee": 400, "accepts_emergency": False},
    {"full_name": "Dr. Sameer Rao", "email": "sameer.rao@citycare.example", "specialisation": "Cardiology", "hospital": 0, "years": 18, "fee": 900, "accepts_emergency": True},
    {"full_name": "Dr. Priya Nair", "email": "priya.nair@citycare.example", "specialisation": "Pediatrics", "hospital": 1, "years": 9, "fee": 450, "accepts_emergency": True},
    {"full_name": "Dr. Vikram Singh", "email": "vikram.singh@citycare.example", "specialisation": "Pediatrics", "hospital": 2, "years": 4, "fee": 400, "accepts_emergency": False},
    {"full_name": "Dr. Neha Kapoor", "email": "neha.kapoor@citycare.example", "specialisation": "Dermatology", "hospital": 0, "years": 7, "fee": 600, "accepts_emergency": False},
    {"full_name": "Dr. Arjun Desai", "email": "arjun.desai@citycare.example", "specialisation": "Orthopedics", "hospital": 2, "years": 15, "fee": 800, "accepts_emergency": True},
    {"full_name": "Dr. Kavita Iyer", "email": "kavita.iyer@citycare.example", "specialisation": "ENT", "hospital": 1, "years": 10, "fee": 550, "accepts_emergency": False},
]

PATIENTS = [
    {"full_name": "Aditya Sharma", "email": "aditya.sharma@example.com", "dob": dt.date(1990, 4, 12), "sex": "male"},
    {"full_name": "Meera Pillai", "email": "meera.pillai@example.com", "dob": dt.date(1985, 11, 2), "sex": "female"},
    {"full_name": "Karan Malhotra", "email": "karan.malhotra@example.com", "dob": dt.date(1998, 7, 23), "sex": "male"},
    {"full_name": "Sneha Reddy", "email": "sneha.reddy@example.com", "dob": dt.date(2001, 1, 30), "sex": "female"},
    {"full_name": "Farhan Ahmed", "email": "farhan.ahmed@example.com", "dob": dt.date(1975, 9, 15), "sex": "male"},
]

# weekday 0=Monday per doctor_working_hours.weekday convention
STANDARD_HOURS = [(0, 1, 2, 3, 4)]  # Mon-Fri


async def seed() -> None:
    async with SessionLocal() as session:
        hospital_ids: list = []
        for h in HOSPITALS:
            existing = await session.scalar(select(Hospital).where(Hospital.name == h["name"]))
            if existing:
                hospital_ids.append(existing.id)
                continue
            hospital = Hospital(**h)
            session.add(hospital)
            await session.flush()
            hospital_ids.append(hospital.id)
        print(f"hospitals: {len(hospital_ids)}")

        admin_email = "admin@citycare.example"
        existing_admin = await session.scalar(select(User).where(User.email == admin_email))
        if not existing_admin:
            admin = User(
                email=admin_email,
                full_name="Clinic Admin",
                password_hash=hash_password(DEV_PASSWORD),
                role=UserRole.admin,
                is_active=True,
            )
            session.add(admin)
            print(f"admin created: {admin_email} / {DEV_PASSWORD}")
        else:
            print("admin already exists")

        doctor_count = 0
        for d in DOCTORS:
            existing = await session.scalar(select(User).where(User.email == d["email"]))
            if existing:
                continue
            user = User(
                email=d["email"],
                full_name=d["full_name"],
                password_hash=hash_password(DEV_PASSWORD),
                role=UserRole.doctor,
                is_active=True,
            )
            session.add(user)
            await session.flush()

            profile = DoctorProfile(
                user_id=user.id,
                hospital_id=hospital_ids[d["hospital"]],
                specialisation=d["specialisation"],
                years_experience=d["years"],
                consultation_fee=d["fee"],
                accepts_emergency=d["accepts_emergency"],
                slot_duration_min=20,
                is_accepting=True,
                bio=f"{d['full_name']} is a {d['specialisation']} specialist with {d['years']} years of experience.",
            )
            session.add(profile)

            for weekday in range(0, 5):  # Monday-Friday
                session.add(
                    DoctorWorkingHours(
                        doctor_id=user.id,
                        weekday=weekday,
                        start_time=dt.time(9, 0),
                        end_time=dt.time(17, 0),
                    )
                )
            doctor_count += 1
        print(f"doctors created: {doctor_count}")

        patient_count = 0
        for p in PATIENTS:
            existing = await session.scalar(select(User).where(User.email == p["email"]))
            if existing:
                continue
            user = User(
                email=p["email"],
                full_name=p["full_name"],
                password_hash=hash_password(DEV_PASSWORD),
                role=UserRole.patient,
                is_active=True,
            )
            session.add(user)
            await session.flush()
            session.add(
                PatientProfile(
                    user_id=user.id,
                    date_of_birth=p["dob"],
                    sex=p["sex"],
                    preferred_language="en",
                )
            )
            patient_count += 1
        print(f"patients created: {patient_count}")

        await session.commit()
    print("seed complete")


if __name__ == "__main__":
    asyncio.run(seed())
