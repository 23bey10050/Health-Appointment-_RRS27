"""Google Calendar integration -- IMPLEMENTATION.md section 13.2.

Calendar is best-effort everywhere: nothing in this module may raise out to a
caller in the booking path. Every public function catches its own failures and
records them on `calendar_links.sync_state` / `last_error` instead -- the .ics
attachment (services/calendar_ics.py) is the guaranteed path; this is the upgrade.
"""

import asyncio
import uuid
from datetime import datetime
from functools import lru_cache

import structlog
from cryptography.fernet import Fernet, InvalidToken
from google.auth.exceptions import RefreshError
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models.appointment import Appointment
from app.models.hospital import Hospital
from app.models.notification import CalendarLink, GoogleOAuthToken
from app.models.user import User

logger = structlog.get_logger(__name__)
settings = get_settings()

SCOPES = ["https://www.googleapis.com/auth/calendar.events"]


class CalendarNotConfigured(Exception):
    """GOOGLE_CLIENT_ID/SECRET aren't set. Expected in most dev/demo environments --
    callers treat this exactly like any other best-effort calendar failure."""


@lru_cache
def _fernet() -> Fernet:
    if not settings.CALENDAR_TOKEN_ENCRYPTION_KEY:
        raise CalendarNotConfigured("CALENDAR_TOKEN_ENCRYPTION_KEY is not set")
    return Fernet(settings.CALENDAR_TOKEN_ENCRYPTION_KEY.encode())


def _client_config() -> dict:
    if not settings.GOOGLE_CLIENT_ID or not settings.GOOGLE_CLIENT_SECRET:
        raise CalendarNotConfigured("GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET are not set")
    return {
        "web": {
            "client_id": settings.GOOGLE_CLIENT_ID,
            "client_secret": settings.GOOGLE_CLIENT_SECRET,
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
            "redirect_uris": [settings.GOOGLE_REDIRECT_URI],
        }
    }


def get_authorization_url(state: str) -> str:
    flow = Flow.from_client_config(_client_config(), scopes=SCOPES, state=state)
    flow.redirect_uri = settings.GOOGLE_REDIRECT_URI
    url, _ = flow.authorization_url(access_type="offline", prompt="consent", include_granted_scopes="true")
    return url


async def handle_oauth_callback(session: AsyncSession, user_id: uuid.UUID, code: str) -> None:
    def _exchange() -> Credentials:
        flow = Flow.from_client_config(_client_config(), scopes=SCOPES)
        flow.redirect_uri = settings.GOOGLE_REDIRECT_URI
        flow.fetch_token(code=code)
        return flow.credentials

    creds = await asyncio.to_thread(_exchange)
    if not creds.refresh_token:
        # Google only issues a refresh token on the *first* consent (or with
        # prompt=consent, which we always pass) -- if it's still missing the user
        # partially revoked access without fully disconnecting. Ask them to redo it.
        raise CalendarNotConfigured("Google did not return a refresh token -- reconnect required")

    encrypted = _fernet().encrypt(creds.refresh_token.encode())
    existing = await session.get(GoogleOAuthToken, user_id)
    if existing:
        existing.refresh_token_encrypted = encrypted
        existing.scopes = creds.scopes or SCOPES
        existing.revoked_at = None
    else:
        session.add(
            GoogleOAuthToken(
                user_id=user_id,
                refresh_token_encrypted=encrypted,
                scopes=creds.scopes or SCOPES,
            )
        )
    await session.commit()


async def disconnect(session: AsyncSession, user_id: uuid.UUID) -> None:
    token = await session.get(GoogleOAuthToken, user_id)
    if token:
        await session.delete(token)
        await session.commit()


async def _get_credentials(session: AsyncSession, user_id: uuid.UUID) -> Credentials | None:
    token = await session.get(GoogleOAuthToken, user_id)
    if token is None or token.revoked_at is not None:
        return None
    try:
        refresh_token = _fernet().decrypt(token.refresh_token_encrypted).decode()
    except InvalidToken:
        logger.error("calendar_token_decrypt_failed", user_id=str(user_id))
        return None

    creds = Credentials(
        token=None,
        refresh_token=refresh_token,
        token_uri="https://oauth2.googleapis.com/token",
        client_id=settings.GOOGLE_CLIENT_ID,
        client_secret=settings.GOOGLE_CLIENT_SECRET,
        scopes=token.scopes,
    )

    def _refresh():
        creds.refresh(Request())

    try:
        await asyncio.to_thread(_refresh)
    except RefreshError:
        # Token revoked on Google's side -- clear our copy so the UI can prompt
        # to reconnect instead of retrying a dead token forever.
        token.revoked_at = datetime.now(creds.expiry.tzinfo) if creds.expiry else None
        await session.commit()
        return None
    return creds


def _event_body(appt: Appointment, doctor_name: str, patient_name: str, hospital: Hospital | None) -> dict:
    return {
        "summary": f"Appointment: {doctor_name} / {patient_name}",
        "location": hospital.address if hospital else None,
        "start": {"dateTime": appt.start_at.isoformat()},
        "end": {"dateTime": appt.end_at.isoformat()},
        "extendedProperties": {"private": {"appointment_id": str(appt.id)}},
    }


async def upsert_event_for_user(session: AsyncSession, appointment_id: uuid.UUID, user_id: uuid.UUID) -> None:
    """Best-effort. Never raises -- every failure path updates calendar_links and returns.

    Most patients and doctors will never connect Google Calendar -- the .ics
    attachment is the path for everyone else (section 13.1). Checking for a token
    *before* creating a calendar_links row means reconcile_calendar (every 6h)
    only ever retries genuine failures, not "this user was never connected" on an
    endless loop.
    """
    creds = await _get_credentials(session, user_id)
    if creds is None:
        return

    link = await session.scalar(
        select(CalendarLink).where(
            CalendarLink.appointment_id == appointment_id, CalendarLink.user_id == user_id
        )
    )
    if link is None:
        link = CalendarLink(appointment_id=appointment_id, user_id=user_id, sync_state="pending")
        session.add(link)
        await session.flush()

    try:
        appt = await session.get(Appointment, appointment_id)
        doctor = await session.get(User, appt.doctor_id)
        patient = await session.get(User, appt.patient_id)
        hospital = await session.get(Hospital, appt.hospital_id) if appt.hospital_id else None
        body = _event_body(appt, doctor.full_name if doctor else "Doctor", patient.full_name if patient else "Patient", hospital)

        def _call():
            service = build("calendar", "v3", credentials=creds, cache_discovery=False)
            if link.google_event_id:
                return service.events().patch(
                    calendarId=link.calendar_id, eventId=link.google_event_id, body=body
                ).execute()
            return service.events().insert(calendarId=link.calendar_id, body=body).execute()

        event = await asyncio.to_thread(_call)
        link.google_event_id = event["id"]
        link.sync_state = "synced"
        link.last_error = None
        await session.commit()
    except HttpError as e:
        link.sync_state = "failed"
        link.last_error = str(e)[:2000]
        await session.commit()
        logger.warning("calendar_upsert_failed", appointment_id=str(appointment_id), error=str(e))
    except CalendarNotConfigured:
        link.sync_state = "failed"
        link.last_error = "calendar not configured"
        await session.commit()
    except Exception as e:  # noqa: BLE001 -- best-effort by design, see module docstring
        link.sync_state = "failed"
        link.last_error = str(e)[:2000]
        await session.commit()
        logger.error("calendar_upsert_unexpected_error", appointment_id=str(appointment_id), error=str(e))


async def delete_event_for_user(session: AsyncSession, appointment_id: uuid.UUID, user_id: uuid.UUID) -> None:
    link = await session.scalar(
        select(CalendarLink).where(
            CalendarLink.appointment_id == appointment_id, CalendarLink.user_id == user_id
        )
    )
    if link is None or not link.google_event_id:
        return

    try:
        creds = await _get_credentials(session, user_id)
        if creds is None:
            link.sync_state = "failed"
            await session.commit()
            return

        def _call():
            service = build("calendar", "v3", credentials=creds, cache_discovery=False)
            service.events().delete(calendarId=link.calendar_id, eventId=link.google_event_id).execute()

        await asyncio.to_thread(_call)
        link.sync_state = "deleted"
        link.last_error = None
        await session.commit()
    except HttpError as e:
        if e.resp.status == 410:  # already gone -- treat as success
            link.sync_state = "deleted"
            await session.commit()
            return
        link.sync_state = "failed"
        link.last_error = str(e)[:2000]
        await session.commit()
        logger.warning("calendar_delete_failed", appointment_id=str(appointment_id), error=str(e))
    except Exception as e:  # noqa: BLE001
        link.sync_state = "failed"
        link.last_error = str(e)[:2000]
        await session.commit()
        logger.error("calendar_delete_unexpected_error", appointment_id=str(appointment_id), error=str(e))
