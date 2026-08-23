import uuid
from datetime import UTC, datetime

import jwt as pyjwt
from fastapi import APIRouter, Depends, HTTPException, Request, status
from redis.asyncio import Redis
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.core.rate_limit import rate_limit
from app.core.security import (
    CurrentUser,
    TOKEN_TYPE_REFRESH,
    create_access_token,
    create_refresh_token,
    decode_token,
    get_current_user,
    hash_password,
    verify_password,
)
from app.db.session import get_session
from app.deps import get_redis
from app.models.enums import UserRole
from app.models.user import PatientProfile, User
from app.schemas.auth import LoginRequest, RefreshRequest, RegisterRequest, TokenResponse, UserOut
from app.services.audit import record_audit


def _client_ip(request: Request) -> str | None:
    return request.client.host if request.client else None

router = APIRouter(prefix="/auth", tags=["auth"])
settings = get_settings()


def _blacklist_key(jti: str) -> str:
    return f"jwt:blacklist:{jti}"


async def _issue_tokens(user: User, redis: Redis) -> TokenResponse:
    return TokenResponse(
        access_token=create_access_token(subject=user.id, role=user.role.value),
        refresh_token=create_refresh_token(subject=user.id, role=user.role.value),
    )


@router.post(
    "/register",
    response_model=TokenResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(rate_limit("register", limit=5, window_seconds=60))],
)
async def register(
    body: RegisterRequest,
    request: Request,
    session: AsyncSession = Depends(get_session),
    redis: Redis = Depends(get_redis),
) -> TokenResponse:
    existing = await session.scalar(select(User).where(User.email == body.email))
    if existing is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "An account with this email already exists")

    user = User(
        email=body.email,
        phone=body.phone,
        password_hash=hash_password(body.password),
        role=UserRole.patient,
        full_name=body.full_name,
    )
    session.add(user)
    await session.flush()
    session.add(PatientProfile(user_id=user.id))
    await session.commit()

    await record_audit(
        session, actor_id=user.id, actor_role=user.role, action="register",
        entity_type="user", entity_id=user.id, ip_address=_client_ip(request),
    )
    return await _issue_tokens(user, redis)


@router.post(
    "/login",
    response_model=TokenResponse,
    dependencies=[Depends(rate_limit("login", limit=10, window_seconds=60))],
)
async def login(
    body: LoginRequest,
    request: Request,
    session: AsyncSession = Depends(get_session),
    redis: Redis = Depends(get_redis),
) -> TokenResponse:
    user = await session.scalar(select(User).where(User.email == body.email))
    if user is None or not verify_password(body.password, user.password_hash):
        await record_audit(
            session, actor_id=user.id if user else None, actor_role=user.role if user else None,
            action="login_failed", metadata={"email": body.email}, ip_address=_client_ip(request),
        )
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Incorrect email or password")
    if not user.is_active:
        await record_audit(
            session, actor_id=user.id, actor_role=user.role, action="login_denied_inactive",
            entity_type="user", entity_id=user.id, ip_address=_client_ip(request),
        )
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Account is disabled")

    await record_audit(
        session, actor_id=user.id, actor_role=user.role, action="login",
        entity_type="user", entity_id=user.id, ip_address=_client_ip(request),
    )
    return await _issue_tokens(user, redis)


@router.post("/refresh", response_model=TokenResponse)
async def refresh(
    body: RefreshRequest,
    session: AsyncSession = Depends(get_session),
    redis: Redis = Depends(get_redis),
) -> TokenResponse:
    payload = decode_token(body.refresh_token)
    if payload.token_type != TOKEN_TYPE_REFRESH:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Refresh token required")
    if await redis.exists(_blacklist_key(payload.jti)):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Token has been revoked")

    user = await session.get(User, uuid.UUID(payload.sub))
    if user is None or not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Account no longer active")

    # Rotate: the presented refresh token is single-use.
    decoded = pyjwt.decode(
        body.refresh_token, settings.JWT_SECRET, algorithms=[settings.JWT_ALGORITHM]
    )
    remaining = max(int(decoded["exp"] - datetime.now(UTC).timestamp()), 1)
    await redis.set(_blacklist_key(payload.jti), "1", ex=remaining)

    return await _issue_tokens(user, redis)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(
    body: RefreshRequest,
    request: Request,
    session: AsyncSession = Depends(get_session),
    redis: Redis = Depends(get_redis),
) -> None:
    try:
        payload = decode_token(body.refresh_token)
        decoded = pyjwt.decode(
            body.refresh_token, settings.JWT_SECRET, algorithms=[settings.JWT_ALGORITHM]
        )
        remaining = max(int(decoded["exp"] - datetime.now(UTC).timestamp()), 1)
        await redis.set(_blacklist_key(payload.jti), "1", ex=remaining)
        await record_audit(
            session, actor_id=uuid.UUID(payload.sub), actor_role=None, action="logout",
            entity_type="user", entity_id=uuid.UUID(payload.sub), ip_address=_client_ip(request),
        )
    except HTTPException:
        # Already invalid/expired -- logging out of a dead token is a no-op, not an error.
        pass


@router.get("/me", response_model=UserOut)
async def me(
    current: CurrentUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> User:
    user = await session.get(User, current.id)
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")
    return user
