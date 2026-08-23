from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Core
    # Managed Postgres note: this driver is asyncpg, so the connection string
    # takes `?ssl=require`, NOT libpq's `?sslmode=require` (asyncpg rejects the
    # latter). Use the provider's DIRECT endpoint, not a transaction-mode pooler
    # -- services/booking.py relies on pg_advisory_xact_lock, which does not
    # survive PgBouncer in transaction mode.
    DATABASE_URL: str = "postgresql+asyncpg://clinic:clinic@localhost:5432/clinic"
    DB_POOL_SIZE: int = 5
    DB_MAX_OVERFLOW: int = 5
    DB_POOL_RECYCLE_SECONDS: int = 300
    REDIS_URL: str = "redis://localhost:6379/0"
    JWT_SECRET: str = "dev-secret-change-me"
    JWT_ALGORITHM: str = "HS256"
    JWT_ACCESS_TTL_MIN: int = 15
    JWT_REFRESH_TTL_DAYS: int = 7
    CALENDAR_TOKEN_ENCRYPTION_KEY: str = ""
    APP_BASE_URL: str = "http://localhost:5173"
    CLINIC_NAME: str = "City Care Clinic"
    DEFAULT_TIMEZONE: str = "Asia/Kolkata"
    ENVIRONMENT: str = "development"

    # LLM providers
    # Model names verified live against each provider's /models endpoint on
    # 2026-08-23 (see .env.example) -- these catalogs move fast; the plan's
    # original mid-2026 names (llama-3.1-8b-instant, llama-3.3-70b-versatile,
    # gemini-2.5-*, llama3.1-8b) were already gone by build time.
    GROQ_API_KEY: str = ""
    GROQ_FAST_MODEL: str = "openai/gpt-oss-20b"
    GROQ_REASON_MODEL: str = "openai/gpt-oss-120b"
    GEMINI_API_KEY: str = ""
    GEMINI_FAST_MODEL: str = "gemini-3.5-flash-lite"
    GEMINI_REASON_MODEL: str = "gemini-3.5-flash"
    CEREBRAS_API_KEY: str = ""
    CEREBRAS_FAST_MODEL: str = "gpt-oss-120b"
    OLLAMA_BASE_URL: str = "http://localhost:11434"
    OLLAMA_FAST_MODEL: str = "qwen3:8b"
    OLLAMA_REASON_MODEL: str = "qwen3:14b"
    LLM_REDACT_PHI: bool = True

    # Speech: no settings. STT is the browser's Web Speech API and TTS is its
    # speechSynthesis, both entirely client-side. The former STT_*/PIPER_* settings
    # (faster-whisper model size/device, Piper voice paths) are gone with those
    # engines -- keeping them would imply a server-side speech pipeline that no
    # longer exists.

    # RAG
    EMBEDDING_MODEL: str = "BAAI/bge-small-en-v1.5"
    # Section 8.2 specifies bge-reranker-v2-m3, which fastembed doesn't carry.
    # bge-reranker-base was tried first and measured ~10s for 20 candidates on
    # CPU -- it's a cross-lingual model, and this KB is English-only.
    # ms-marco-MiniLM is the fast English cross-encoder for this job.
    RERANKER_MODEL: str = "Xenova/ms-marco-MiniLM-L-6-v2"
    RERANK_SCORE_GAP_THRESHOLD: float = 0.05

    # Retrieve clinic context on every voice turn, versus only when the agent
    # asks via lookup_clinic_info. Off by default for latency: every utterance is
    # a distinct query so the cache never hits, costing ~1.1s of CPU-bound
    # embedding per turn -- including the many turns that need no KB at all.
    VOICE_RAG_PER_TURN: bool = False

    # Email
    EMAIL_PROVIDER: str = "smtp"
    BREVO_API_KEY: str = ""
    SMTP_HOST: str = "localhost"
    SMTP_PORT: int = 1025
    SMTP_USER: str = ""
    SMTP_PASSWORD: str = ""
    EMAIL_FROM: str = "City Care Clinic <noreply@example.com>"

    # Google
    GOOGLE_CLIENT_ID: str = ""
    GOOGLE_CLIENT_SECRET: str = ""
    GOOGLE_REDIRECT_URI: str = "http://localhost:8000/api/v1/calendar/callback"

    # Voice / safety
    VOICE_SESSION_MAX_MIN: int = 15
    SLOT_HOLD_TTL_SECONDS: int = 300
    AUDIO_RETENTION_DAYS: int = 7
    EMERGENCY_NUMBERS: str = "108,112"
    MENTAL_HEALTH_HELPLINE: str = "14416"
    ONCALL_ALERT_EMAILS: str = ""

    # Comma-separated extra origins. APP_BASE_URL is always allowed; this exists
    # because APP_BASE_URL also drives OAuth redirects, email links and ICS UIDs,
    # so it can't be repurposed to list several origins (apex + www, or a preview
    # deploy). allow_credentials=True means no wildcard, so these must be exact.
    CORS_ALLOWED_ORIGINS: str = ""

    # Shared secret for the scheduled-job endpoints (api/v1/jobs.py). Free-tier
    # hosting has no background worker, so an external cron drives them over HTTP.
    JOBS_SECRET: str = ""

    @property
    def cors_origins_list(self) -> list[str]:
        extra = [o.strip().rstrip("/") for o in self.CORS_ALLOWED_ORIGINS.split(",") if o.strip()]
        return list(dict.fromkeys([self.APP_BASE_URL.rstrip("/"), *extra]))

    @property
    def emergency_numbers_list(self) -> list[str]:
        return [n.strip() for n in self.EMERGENCY_NUMBERS.split(",") if n.strip()]

    @property
    def oncall_alert_emails_list(self) -> list[str]:
        return [e.strip() for e in self.ONCALL_ALERT_EMAILS.split(",") if e.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
