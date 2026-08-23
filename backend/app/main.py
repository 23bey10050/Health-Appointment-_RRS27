from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.v1.router import api_router
from app.api.v1.voice_ws import router as voice_ws_router
from app.config import get_settings
from app.core.errors import register_exception_handlers
from app.core.logging import configure_logging

settings = get_settings()
logger = structlog.get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    configure_logging(json_logs=settings.ENVIRONMENT != "development")

    # No speech-model warm-up any more: STT is the browser's Web Speech API and
    # TTS is its speechSynthesis, so nothing heavy loads at startup. This is what
    # keeps the image small enough for a free-tier container.
    yield


app = FastAPI(title="Clinic Voice Platform API", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

register_exception_handlers(app)
app.include_router(api_router)
# Section 14: the WS endpoint is /ws/voice/{session_id}, deliberately not under
# /api/v1 -- api_router carries that prefix, so this is mounted separately.
app.include_router(voice_ws_router)


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}
