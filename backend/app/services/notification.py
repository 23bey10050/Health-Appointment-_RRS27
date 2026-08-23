"""Transactional outbox: write side (`enqueue_email`, called from booking/leave/etc.
inside the same transaction as the domain change -- section 13.1) and send side
(`send_rendered_email`, called by the Celery dispatcher in workers/email_dispatch.py).
Two providers: Brevo's HTTP API (production default) and SMTP via aiosmtplib (local
dev, and Brevo's fallback name for docker-compose's mailpit/MailHog-less setup).
"""

import base64
import uuid
from email.message import EmailMessage
from typing import Any

import aiosmtplib
import httpx
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models.notification import EmailOutbox

settings = get_settings()

BREVO_SEND_URL = "https://api.brevo.com/v3/smtp/email"

# Templates that represent a bookable event get an .ics attachment -- the fallback
# calendar path for anyone who hasn't connected Google Calendar (section 13.1).
ICS_TEMPLATES = {"booking_confirmation_patient", "booking_confirmation_doctor", "appointment_rescheduled"}


async def enqueue_email(
    session: AsyncSession,
    *,
    idempotency_key: str,
    to_email: str,
    template: str,
    context: dict[str, Any],
) -> None:
    stmt = (
        pg_insert(EmailOutbox)
        .values(
            idempotency_key=idempotency_key,
            to_email=to_email,
            template=template,
            context=context,
        )
        .on_conflict_do_nothing(index_elements=["idempotency_key"])
    )
    await session.execute(stmt)


class EmailSendError(Exception):
    """Raised by a provider backend on any non-success response. The dispatcher is
    the only thing that should decide what happens next (retry vs. dead-letter)."""


def _from_address() -> tuple[str, str]:
    """EMAIL_FROM is 'Display Name <addr@example.com>' -- split it for providers
    (Brevo) that want name and address as separate fields."""
    raw = settings.EMAIL_FROM
    if "<" in raw and raw.endswith(">"):
        name, addr = raw.rsplit("<", 1)
        return name.strip().strip('"'), addr.rstrip(">").strip()
    return settings.CLINIC_NAME, raw.strip()


async def _send_via_brevo(
    *, to_email: str, subject: str, html: str, text: str, ics_attachment: bytes | None
) -> str:
    from_name, from_addr = _from_address()
    payload: dict[str, Any] = {
        "sender": {"name": from_name, "email": from_addr},
        "to": [{"email": to_email}],
        "subject": subject,
        "htmlContent": html,
        "textContent": text,
    }
    if ics_attachment:
        payload["attachment"] = [
            {"content": base64.b64encode(ics_attachment).decode("ascii"), "name": "appointment.ics"}
        ]

    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(
            BREVO_SEND_URL,
            headers={"api-key": settings.BREVO_API_KEY, "content-type": "application/json"},
            json=payload,
        )
    if resp.status_code >= 400:
        raise EmailSendError(f"Brevo {resp.status_code}: {resp.text[:500]}")
    return resp.json().get("messageId", "")


async def _send_via_smtp(
    *, to_email: str, subject: str, html: str, text: str, ics_attachment: bytes | None
) -> str:
    from_name, from_addr = _from_address()
    message = EmailMessage()
    message["From"] = f"{from_name} <{from_addr}>"
    message["To"] = to_email
    message["Subject"] = subject
    message.set_content(text)
    message.add_alternative(html, subtype="html")
    if ics_attachment:
        message.add_attachment(
            ics_attachment, maintype="text", subtype="calendar", filename="appointment.ics"
        )

    try:
        await aiosmtplib.send(
            message,
            hostname=settings.SMTP_HOST,
            port=settings.SMTP_PORT,
            username=settings.SMTP_USER or None,
            password=settings.SMTP_PASSWORD or None,
            start_tls=bool(settings.SMTP_USER),  # local dev SMTP (no auth) skips TLS
        )
    except (aiosmtplib.SMTPException, OSError) as e:
        raise EmailSendError(f"SMTP send failed: {e}") from e
    return str(uuid.uuid4())  # SMTP gives no provider message id; mint a local one


async def send_rendered_email(
    *, to_email: str, subject: str, html: str, text: str, ics_attachment: bytes | None = None
) -> str:
    """Returns the provider message id. Raises EmailSendError on any failure --
    callers (the dispatcher) own retry/backoff, this function never retries itself."""
    if settings.EMAIL_PROVIDER == "brevo":
        return await _send_via_brevo(to_email=to_email, subject=subject, html=html, text=text, ics_attachment=ics_attachment)
    return await _send_via_smtp(to_email=to_email, subject=subject, html=html, text=text, ics_attachment=ics_attachment)
