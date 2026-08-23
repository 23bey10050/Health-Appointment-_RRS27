import uuid

from fastapi import APIRouter, Depends, Query
from fastapi.responses import RedirectResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.core.security import (
    TOKEN_TYPE_OAUTH_STATE,
    CurrentUser,
    create_oauth_state_token,
    decode_token,
    get_current_user,
)
from app.db.session import get_session
from app.models.notification import GoogleOAuthToken
from app.services.calendar import CalendarNotConfigured, disconnect, get_authorization_url, handle_oauth_callback

router = APIRouter(prefix="/calendar", tags=["calendar"])
settings = get_settings()


@router.get("/status")
async def status_endpoint(
    current: CurrentUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> dict:
    token = await session.get(GoogleOAuthToken, current.id)
    connected = token is not None and token.revoked_at is None
    return {"connected": connected, "connected_at": token.connected_at.isoformat() if connected else None}


@router.get("/connect")
async def connect(current: CurrentUser = Depends(get_current_user)) -> dict:
    """Returns the Google consent URL rather than redirecting directly: the frontend
    calls this as an authenticated fetch(), then does the actual browser navigation
    itself (see api/v1/calendar_oauth.py module docstring pattern in calendar.py)."""
    state = create_oauth_state_token(user_id=current.id)
    try:
        url = get_authorization_url(state)
    except CalendarNotConfigured:
        return {"authorization_url": None, "configured": False}
    return {"authorization_url": url, "configured": True}


@router.get("/callback")
async def callback(
    code: str = Query(...),
    state: str = Query(...),
    session: AsyncSession = Depends(get_session),
) -> RedirectResponse:
    """Google redirects the browser here directly -- no Authorization header, hence
    the signed `state` carrying the user id (section: create_oauth_state_token)."""
    try:
        payload = decode_token(state)
    except Exception:
        return RedirectResponse(f"{settings.APP_BASE_URL}/settings?calendar=invalid_state")
    if payload.token_type != TOKEN_TYPE_OAUTH_STATE:
        return RedirectResponse(f"{settings.APP_BASE_URL}/settings?calendar=invalid_state")

    try:
        await handle_oauth_callback(session, uuid.UUID(payload.sub), code)
    except CalendarNotConfigured:
        return RedirectResponse(f"{settings.APP_BASE_URL}/settings?calendar=error")

    return RedirectResponse(f"{settings.APP_BASE_URL}/settings?calendar=connected")


@router.delete("/disconnect", status_code=204)
async def disconnect_calendar(
    current: CurrentUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> None:
    await disconnect(session, current.id)
