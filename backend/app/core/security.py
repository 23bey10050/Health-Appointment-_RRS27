import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.config import get_settings
from app.models.enums import UserRole

settings = get_settings()
_hasher = PasswordHasher()
_bearer = HTTPBearer(auto_error=False)


# ---------------------------------------------------------------------------
# Password hashing (Argon2id -- argon2-cffi's PasswordHasher defaults to id)
# ---------------------------------------------------------------------------


def hash_password(raw: str) -> str:
    return _hasher.hash(raw)


def verify_password(raw: str, hashed: str) -> bool:
    try:
        return _hasher.verify(hashed, raw)
    except VerifyMismatchError:
        return False


# ---------------------------------------------------------------------------
# JWT
# ---------------------------------------------------------------------------

TOKEN_TYPE_ACCESS = "access"
TOKEN_TYPE_REFRESH = "refresh"
TOKEN_TYPE_REBOOK = "rebook"
TOKEN_TYPE_OAUTH_STATE = "oauth_state"
TOKEN_TYPE_VOICE_TICKET = "voice_ticket"


class TokenPayload:
    def __init__(self, sub: str, role: str, token_type: str, jti: str, **extra):
        self.sub = sub
        self.role = role
        self.token_type = token_type
        self.jti = jti
        self.extra = extra


def _create_token(*, subject: uuid.UUID, role: str, token_type: str, ttl: timedelta) -> str:
    now = datetime.now(UTC)
    payload: dict[str, Any] = {
        "sub": str(subject),
        "role": role,
        "type": token_type,
        "jti": str(uuid.uuid4()),
        "iat": now,
        "exp": now + ttl,
    }
    return jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)


def create_access_token(*, subject: uuid.UUID, role: str) -> str:
    return _create_token(
        subject=subject,
        role=role,
        token_type=TOKEN_TYPE_ACCESS,
        ttl=timedelta(minutes=settings.JWT_ACCESS_TTL_MIN),
    )


def create_rebook_token(*, appointment_id: uuid.UUID, ttl_days: int = 14) -> str:
    """Signed link for a doctor-leave cancellation email: 'rebook this appointment'
    with no other privileges. Long-lived on purpose -- it sits in an inbox, not a
    browser session -- and carries no role, so it can never be presented as an
    access token (decode_token's callers all check `token_type`)."""
    return _create_token(
        subject=appointment_id,
        role="",
        token_type=TOKEN_TYPE_REBOOK,
        ttl=timedelta(days=ttl_days),
    )


def create_oauth_state_token(*, user_id: uuid.UUID, ttl_minutes: int = 10) -> str:
    """The Google OAuth `state` param: identifies who's connecting when the callback
    comes back as a plain browser redirect with no Authorization header to read."""
    return _create_token(
        subject=user_id,
        role="",
        token_type=TOKEN_TYPE_OAUTH_STATE,
        ttl=timedelta(minutes=ttl_minutes),
    )


def create_voice_ticket(*, session_id: uuid.UUID, patient_id: uuid.UUID | None, ttl_seconds: int = 60) -> str:
    """Section 14: "Authenticate the WebSocket with a short-lived (60s) single-use
    ticket issued by POST /voice/sessions. Do not put JWTs in query strings."
    Carries both session_id (as `sub`, so decode_token's existing shape works) and
    patient_id (a custom claim -- no other token type needs two identifiers, so
    this doesn't go through the generic single-subject _create_token)."""
    now = datetime.now(UTC)
    payload: dict[str, Any] = {
        "sub": str(session_id),
        "role": "",
        "type": TOKEN_TYPE_VOICE_TICKET,
        "jti": str(uuid.uuid4()),
        "patient_id": str(patient_id) if patient_id else None,
        "iat": now,
        "exp": now + timedelta(seconds=ttl_seconds),
    }
    return jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)


def create_refresh_token(*, subject: uuid.UUID, role: str) -> str:
    return _create_token(
        subject=subject,
        role=role,
        token_type=TOKEN_TYPE_REFRESH,
        ttl=timedelta(days=settings.JWT_REFRESH_TTL_DAYS),
    )


def decode_token(token: str) -> TokenPayload:
    try:
        raw = jwt.decode(token, settings.JWT_SECRET, algorithms=[settings.JWT_ALGORITHM])
    except jwt.ExpiredSignatureError as e:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Token expired") from e
    except jwt.InvalidTokenError as e:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid token") from e
    known_keys = {"sub", "role", "type", "jti", "iat", "exp"}
    extra = {k: v for k, v in raw.items() if k not in known_keys}
    return TokenPayload(sub=raw["sub"], role=raw["role"], token_type=raw["type"], jti=raw["jti"], **extra)


# ---------------------------------------------------------------------------
# FastAPI dependencies
# ---------------------------------------------------------------------------


class CurrentUser:
    def __init__(self, id: uuid.UUID, role: UserRole):
        self.id = id
        self.role = role


async def get_current_user(
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> CurrentUser:
    if creds is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Missing bearer token")
    payload = decode_token(creds.credentials)
    if payload.token_type != TOKEN_TYPE_ACCESS:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Access token required")
    return CurrentUser(id=uuid.UUID(payload.sub), role=UserRole(payload.role))


def require_role(*roles: UserRole):
    async def _dep(user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
        if user.role not in roles:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Insufficient permissions")
        return user

    return _dep
