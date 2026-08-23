from fastapi import APIRouter

from app.api.v1 import (
    admin,
    appointments,
    auth,
    calendar_oauth,
    doctors,
    emergency,
    encounters,
    jobs,
    summaries,
    voice,
)

api_router = APIRouter(prefix="/api/v1")
api_router.include_router(auth.router)
api_router.include_router(doctors.router)
api_router.include_router(appointments.router)
api_router.include_router(admin.router)
api_router.include_router(calendar_oauth.router)
api_router.include_router(encounters.router)
api_router.include_router(summaries.router)
api_router.include_router(voice.router)
api_router.include_router(emergency.router)
api_router.include_router(jobs.router)
