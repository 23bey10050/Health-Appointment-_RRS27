"""Jinja2 rendering for transactional email -- HTML + plaintext pairs under
app/templates/email/, per IMPLEMENTATION.md section 13.1.
"""

from datetime import datetime
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, TemplateNotFound, select_autoescape

from app.config import get_settings
from app.core.formatting import BlankOnMissing
from app.services.availability import CLINIC_TZ

settings = get_settings()

_TEMPLATE_DIR = Path(__file__).resolve().parent.parent / "templates" / "email"

_env = Environment(
    loader=FileSystemLoader(str(_TEMPLATE_DIR)),
    autoescape=select_autoescape(enabled_extensions=("html",), default_for_string=False),
    trim_blocks=True,
    lstrip_blocks=True,
)


def _format_dt(value: str | datetime) -> str:
    """'Monday, 24 August 2026 at 9:00 AM IST'. Context values arrive as ISO strings
    (that's what JSONB round-trips through email_outbox.context), but accept a real
    datetime too so this filter also works on values that were never serialized."""
    dt = datetime.fromisoformat(value) if isinstance(value, str) else value
    local = dt.astimezone(CLINIC_TZ)
    return local.strftime("%A, %d %B %Y at %-I:%M %p %Z")


_env.filters["format_dt"] = _format_dt

SUBJECTS: dict[str, str] = {
    "booking_confirmation_patient": "Your appointment with {doctor_name} is confirmed",
    "booking_confirmation_doctor": "New appointment: {patient_name}",
    "appointment_reminder_24h": "Reminder: your appointment tomorrow",
    "appointment_reminder_2h": "Your appointment is in 2 hours",
    "appointment_cancelled": "Your appointment has been cancelled",
    "appointment_cancelled_doctor_leave": "Your appointment needs to be rescheduled",
    "appointment_rescheduled": "Your appointment has been rescheduled",
    "medication_reminder": "Time for your medication: {drug_name}",
    "post_visit_summary": "Your visit summary",
    "emergency_alert_doctor": "URGENT: emergency escalation -- {category}",
}


def render_email(template: str, context: dict) -> tuple[str, str, str]:
    """Returns (subject, html_body, text_body). Raises TemplateNotFound if `template`
    isn't a real template name -- callers should let that surface as a loud failure
    (a typo'd template name enqueued into email_outbox is a bug, not a runtime case
    to paper over)."""
    full_context = {
        "clinic_name": settings.CLINIC_NAME,
        "app_base_url": settings.APP_BASE_URL,
        **context,
    }

    try:
        html = _env.get_template(f"{template}.html").render(**full_context)
        text = _env.get_template(f"{template}.txt").render(**full_context)
    except TemplateNotFound as e:
        raise TemplateNotFound(f"No email template named '{template}'") from e

    subject_template = SUBJECTS.get(template, settings.CLINIC_NAME)
    subject = subject_template.format_map(BlankOnMissing(None, full_context))
    return subject, html, text
