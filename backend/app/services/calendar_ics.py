"""Minimal .ics builder -- the fallback calendar path for every confirmation email,
independent of whether the patient ever connects Google Calendar (section 13.1)."""

import uuid
from datetime import datetime

from icalendar import Calendar, Event

from app.config import get_settings

settings = get_settings()


def build_ics(
    *,
    appointment_id: uuid.UUID,
    summary: str,
    start_at: datetime,
    end_at: datetime,
    location: str | None = None,
    description: str | None = None,
) -> bytes:
    cal = Calendar()
    cal.add("prodid", f"-//{settings.CLINIC_NAME}//Booking//EN")
    cal.add("version", "2.0")
    cal.add("method", "PUBLISH")

    event = Event()
    event.add("uid", f"{appointment_id}@{_domain()}")
    event.add("summary", summary)
    event.add("dtstart", start_at)
    event.add("dtend", end_at)
    event.add("dtstamp", datetime.now(start_at.tzinfo))
    if location:
        event.add("location", location)
    if description:
        event.add("description", description)

    cal.add_component(event)
    return cal.to_ical()


def _domain() -> str:
    base = settings.APP_BASE_URL.split("//", 1)[-1]
    return base.split("/", 1)[0] or "clinic.local"
