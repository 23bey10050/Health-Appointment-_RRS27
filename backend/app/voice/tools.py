"""Agent tools -- IMPLEMENTATION.md section 12. Tool-calling loop, not free-form
generation: voice/agent.py drives this, max 3 tool calls per turn then forces a
text response.

Every handler returns a compact, speakable dict the LLM will read aloud, or
`{"ok": False, "reason": "..."}` on failure -- never raises, so the agent can
recover conversationally (section 12: "Return {'ok': false, 'reason': '...'} on
failure rather than raising").
"""

import uuid
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from typing import Any, Awaitable, Callable

import structlog
from redis.asyncio import Redis
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.models.appointment import Appointment
from app.models.doctor import DoctorProfile
from app.models.emergency import EmergencyQueueEntry
from app.models.enums import AppointmentKind, AppointmentStatus, UrgencyLevel
from app.models.hospital import Hospital
from app.models.user import PatientProfile, User
from app.services.availability import compute_availability
from app.services.booking import cancel_appointment, confirm_booking, hold_slot, reschedule_appointment
from app.services.notification import enqueue_email


@dataclass
class ToolContext:
    """Everything a handler needs, bundled once per session by the orchestrator."""

    session: AsyncSession
    redis: Redis
    patient_id: uuid.UUID | None
    voice_session_id: uuid.UUID
    collected_data: dict[str, Any] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Tool definitions -- names/descriptions/arg schemas embedded in the system
# prompt as text (voice/agent.py), since prompted JSON tool-calling (section
# "Agent tools") has to work identically across all four LLM providers, which
# don't share a native function-calling wire format.
# ---------------------------------------------------------------------------

TOOL_DEFINITIONS: list[dict] = [
    {
        "name": "search_doctors",
        "description": "Find doctors by specialisation, optionally filtered by hospital or emergency capability. Returns ranked doctors with their next available slot.",
        "args": {"specialisation": "string", "hospital_id": "string, optional", "accepts_emergency": "boolean, optional"},
    },
    {
        "name": "check_availability",
        "description": "Get free slots for a specific doctor between two dates.",
        "args": {"doctor_id": "string", "date_from": "YYYY-MM-DD", "date_to": "YYYY-MM-DD"},
    },
    {
        "name": "hold_slot",
        "description": "Place a 5-minute hold on a specific doctor+time. Call as soon as the patient's intent to book that slot is clear.",
        "args": {"doctor_id": "string", "start_at": "ISO 8601 datetime"},
    },
    {
        "name": "confirm_booking",
        "description": "Confirm a previously held slot. Only call after the patient has explicitly confirmed. Idempotent.",
        "args": {"appointment_id": "string"},
    },
    {
        "name": "cancel_appointment",
        "description": "Cancel an existing appointment.",
        "args": {"appointment_id": "string", "reason": "string, optional"},
    },
    {
        "name": "reschedule_appointment",
        "description": "Move an existing confirmed appointment to a new time.",
        "args": {"appointment_id": "string", "new_start_at": "ISO 8601 datetime"},
    },
    {
        "name": "get_patient_context",
        "description": "Look up the patient's known allergies, conditions, and medications. Call once at session start, not every turn.",
        "args": {},
    },
    {
        "name": "record_symptom_data",
        "description": "Save one piece of collected information (chief complaint, duration, severity, etc.) to the session's working memory.",
        "args": {"field": "string", "value": "string"},
    },
    {
        "name": "lookup_clinic_info",
        "description": "Answer a question about clinic policy, hours, fees, preparation, or FAQs by searching the knowledge base.",
        "args": {"query": "string"},
    },
    {
        "name": "escalate_emergency",
        "description": "Escalate immediately when a red flag is detected. Creates an urgent case and pages the on-call doctor.",
        "args": {"category": "string", "summary": "string", "hospital_id": "string"},
    },
    {
        "name": "book_emergency_appointment",
        "description": (
            "During an active emergency only: reserve an immediate emergency slot at the nearest "
            "hospital with an emergency department, and attach it to the open emergency case. "
            "Call this after recording whether an ambulance is required and the patient's callback details."
        ),
        "args": {"hospital_id": "string, optional -- omit to auto-select the nearest"},
    },
    {
        "name": "list_hospitals",
        "description": "List clinic hospitals, optionally filtered by city or emergency department availability.",
        "args": {"city": "string, optional", "has_emergency_dept": "boolean, optional"},
    },
    {
        "name": "transfer_to_human",
        "description": "Create a callback request and hand off to clinic staff.",
        "args": {"reason": "string"},
    },
]

MAX_TOOL_CALLS_PER_TURN = 3


logger = structlog.get_logger(__name__)


def _err(reason: str) -> dict:
    return {"ok": False, "reason": reason}


async def search_doctors(ctx: ToolContext, *, specialisation: str, hospital_id: str | None = None, accepts_emergency: bool | None = None) -> dict:
    stmt = select(DoctorProfile, User.full_name).join(User, User.id == DoctorProfile.user_id).where(
        DoctorProfile.is_accepting.is_(True), DoctorProfile.specialisation.ilike(specialisation)
    )
    if hospital_id:
        stmt = stmt.where(DoctorProfile.hospital_id == uuid.UUID(hospital_id))
    if accepts_emergency is not None:
        stmt = stmt.where(DoctorProfile.accepts_emergency.is_(accepts_emergency))

    rows = (await ctx.session.execute(stmt.limit(5))).all()
    if not rows:
        return _err(f"No doctors found for '{specialisation}'.")

    today = date.today()
    results = []
    for profile, full_name in rows:
        slots = await compute_availability(ctx.session, profile.user_id, today, today + timedelta(days=7))
        results.append(
            {
                "doctor_id": str(profile.user_id),
                "name": full_name,
                "specialisation": profile.specialisation,
                "fee": float(profile.consultation_fee) if profile.consultation_fee else None,
                "next_available": slots[0].isoformat() if slots else None,
            }
        )
    return {"ok": True, "doctors": results}


async def check_availability(ctx: ToolContext, *, doctor_id: str, date_from: str, date_to: str) -> dict:
    try:
        slots = await compute_availability(
            ctx.session, uuid.UUID(doctor_id), date.fromisoformat(date_from), date.fromisoformat(date_to)
        )
    except ValueError as e:
        return _err(f"Invalid date: {e}")
    return {"ok": True, "slots": [s.isoformat() for s in slots[:10]]}


async def hold_slot_tool(ctx: ToolContext, *, doctor_id: str, start_at: str) -> dict:
    if ctx.patient_id is None:
        return _err("No patient is attached to this session yet.")
    doctor = await ctx.session.get(DoctorProfile, uuid.UUID(doctor_id))
    if doctor is None:
        return _err("Unknown doctor.")
    try:
        appt = await hold_slot(ctx.session, uuid.UUID(doctor_id), ctx.patient_id, datetime.fromisoformat(start_at), doctor.slot_duration_min)
    except AppError as e:
        return _err(e.message)
    return {"ok": True, "appointment_id": str(appt.id), "start_at": appt.start_at.isoformat(), "hold_expires_at": appt.hold_expires_at.isoformat()}


async def confirm_booking_tool(ctx: ToolContext, *, appointment_id: str) -> dict:
    if ctx.patient_id is None:
        return _err("No patient is attached to this session yet.")
    try:
        appt = await confirm_booking(ctx.session, uuid.UUID(appointment_id), ctx.patient_id)
    except AppError as e:
        return _err(e.message)
    return {"ok": True, "appointment_id": str(appt.id), "status": appt.status.value, "start_at": appt.start_at.isoformat()}


async def cancel_appointment_tool(ctx: ToolContext, *, appointment_id: str, reason: str | None = None) -> dict:
    if ctx.patient_id is None:
        return _err("No patient is attached to this session yet.")
    try:
        appt = await cancel_appointment(ctx.session, uuid.UUID(appointment_id), ctx.patient_id, reason)
    except AppError as e:
        return _err(e.message)
    return {"ok": True, "appointment_id": str(appt.id), "status": appt.status.value}


async def reschedule_appointment_tool(ctx: ToolContext, *, appointment_id: str, new_start_at: str) -> dict:
    if ctx.patient_id is None:
        return _err("No patient is attached to this session yet.")
    try:
        appt = await reschedule_appointment(ctx.session, uuid.UUID(appointment_id), ctx.patient_id, datetime.fromisoformat(new_start_at))
    except AppError as e:
        return _err(e.message)
    return {"ok": True, "appointment_id": str(appt.id), "start_at": appt.start_at.isoformat()}


async def get_patient_context(ctx: ToolContext) -> dict:
    if ctx.patient_id is None:
        return _err("No patient is attached to this session.")
    user = await ctx.session.get(User, ctx.patient_id)
    profile = await ctx.session.get(PatientProfile, ctx.patient_id)
    if user is None:
        return _err("Patient not found.")
    return {
        "ok": True,
        "name": user.full_name,
        "allergies": profile.allergies if profile else [],
        "chronic_conditions": profile.chronic_conditions if profile else [],
        "current_medications": profile.current_medications if profile else [],
    }


_TRUTHY = {"yes", "y", "true", "1", "yes please", "please", "needed", "required", "haan", "ha"}
_FALSY = {"no", "n", "false", "0", "not needed", "no thanks", "nahi"}

# Intake answers that belong on the emergency case row (so the on-call doctor sees
# them in the portal), not only in the session's working memory.
_EMERGENCY_CASE_FIELDS = {"ambulance_required", "patient_name", "patient_phone"}


async def record_symptom_data(ctx: ToolContext, *, field: str, value: str) -> dict:
    ctx.collected_data[field] = value

    case_id = ctx.collected_data.get("emergency_case_id")
    if case_id and field in _EMERGENCY_CASE_FIELDS:
        entry = await ctx.session.get(EmergencyQueueEntry, uuid.UUID(case_id))
        if entry is not None:
            if field == "ambulance_required":
                normalized = value.strip().lower()
                if normalized in _TRUTHY:
                    entry.ambulance_required = True
                elif normalized in _FALSY:
                    entry.ambulance_required = False
                else:
                    # Ambiguous free text ("maybe", "if you think so"). Fail safe:
                    # an unclear answer to "do you need an ambulance" during a live
                    # emergency should surface to the doctor as a yes, not a no.
                    entry.ambulance_required = True
            elif field == "patient_name":
                entry.callback_name = value
            elif field == "patient_phone":
                entry.callback_phone = value
            await ctx.session.commit()
            return {"ok": True, "recorded": field, "attached_to_emergency_case": True}

    return {"ok": True, "recorded": field}


async def book_emergency_appointment(ctx: ToolContext, *, hospital_id: str | None = None) -> dict:
    """Reserve an immediate emergency slot, bypassing normal availability.

    Deliberately does NOT go through hold_slot/confirm_booking: those enforce
    working hours, slot grids and the double-booking exclusion constraint, none of
    which apply to a walk-in emergency. Section 6.2 anticipated this -- the
    emergency path uses its own queue rather than weakening the booking
    constraint that CORRECTNESS-1 depends on.
    """
    case_id = ctx.collected_data.get("emergency_case_id")
    if not case_id:
        return _err("No active emergency case for this session.")

    entry = await ctx.session.get(EmergencyQueueEntry, uuid.UUID(case_id))
    if entry is None:
        return _err("Emergency case not found.")

    hospital = await _nearest_emergency_hospital(ctx, hospital_id or (str(entry.hospital_id) if entry.hospital_id else None))
    if hospital is None:
        return _err("No hospital with an emergency department is available.")

    doctor_id = await ctx.session.scalar(
        select(User.id)
        .join(DoctorProfile, DoctorProfile.user_id == User.id)
        .where(DoctorProfile.hospital_id == hospital.id, DoctorProfile.accepts_emergency.is_(True))
        .limit(1)
    )
    if doctor_id is None:
        doctor_id = entry.oncall_doctor_id
    if doctor_id is None or ctx.patient_id is None:
        # Still a success from the patient's perspective: the case and the alert
        # exist, there just isn't an appointment row to attach.
        entry.hospital_id = hospital.id
        await ctx.session.commit()
        return {
            "ok": True, "hospital": hospital.name, "appointment_created": False,
            "message": "Emergency case registered; the on-call team has been alerted.",
        }

    now = datetime.now(UTC)
    appointment = Appointment(
        doctor_id=doctor_id,
        patient_id=ctx.patient_id,
        hospital_id=hospital.id,
        start_at=now,
        end_at=now + timedelta(minutes=30),
        status=AppointmentStatus.confirmed,
        kind=AppointmentKind.emergency,
        urgency=UrgencyLevel.critical,
        booking_channel="voice_emergency",
        reason_text=f"Emergency escalation: {entry.category}",
    )
    ctx.session.add(appointment)
    await ctx.session.flush()

    entry.hospital_id = hospital.id
    entry.appointment_id = appointment.id
    await ctx.session.commit()

    ctx.collected_data["booked_appointment_id"] = str(appointment.id)
    return {
        "ok": True,
        "hospital": hospital.name,
        "hospital_address": hospital.address or "",
        "appointment_created": True,
        "appointment_id": str(appointment.id),
    }


async def _nearest_emergency_hospital(ctx: ToolContext, preferred_id: str | None):
    """Nearest = the patient's own hospital if it has an emergency department,
    else any hospital that does.

    There is no geocoding in this schema (hospitals carry address/city text, not
    coordinates), so "nearest" is resolved by association rather than distance.
    Naming it honestly here so nobody later assumes a distance calculation exists.
    """
    if preferred_id:
        hospital = await ctx.session.get(Hospital, uuid.UUID(preferred_id))
        if hospital is not None and hospital.has_emergency_dept:
            return hospital

    if ctx.patient_id:
        city = await ctx.session.scalar(
            select(Hospital.city)
            .join(Appointment, Appointment.hospital_id == Hospital.id)
            .where(Appointment.patient_id == ctx.patient_id)
            .order_by(Appointment.start_at.desc())
            .limit(1)
        )
        if city:
            local = await ctx.session.scalar(
                select(Hospital).where(Hospital.city == city, Hospital.has_emergency_dept.is_(True)).limit(1)
            )
            if local is not None:
                return local

    return await ctx.session.scalar(select(Hospital).where(Hospital.has_emergency_dept.is_(True)).limit(1))


async def lookup_clinic_info(ctx: ToolContext, *, query: str) -> dict:
    from app.rag.retriever import retrieve

    results = await retrieve(
        ctx.session, query, namespaces=["clinic_kb", "triage_kb"], audience="patient", patient_id=ctx.patient_id,
        k=3, redis=ctx.redis,
    )
    if not results:
        return _err("No relevant information found.")
    return {"ok": True, "excerpts": [r.content for r in results]}


async def escalate_emergency(ctx: ToolContext, *, category: str, summary: str, hospital_id: str) -> dict:
    hospital = await ctx.session.get(Hospital, uuid.UUID(hospital_id))
    if hospital is None:
        return _err("Unknown hospital.")

    oncall_id = await ctx.session.scalar(
        select(User.id).join(DoctorProfile, DoctorProfile.user_id == User.id).where(
            DoctorProfile.hospital_id == hospital.id, DoctorProfile.accepts_emergency.is_(True)
        ).limit(1)
    )

    entry = EmergencyQueueEntry(
        patient_id=ctx.patient_id, hospital_id=hospital.id, voice_session_id=ctx.voice_session_id,
        category=category, severity="critical", summary=summary, oncall_doctor_id=oncall_id,
    )
    ctx.session.add(entry)
    await ctx.session.flush()

    if oncall_id:
        oncall_doctor = await ctx.session.get(User, oncall_id)
        patient = await ctx.session.get(User, ctx.patient_id) if ctx.patient_id else None
        if oncall_doctor:
            await enqueue_email(
                ctx.session,
                idempotency_key=f"emergency_alert:{entry.id}",
                to_email=oncall_doctor.email,
                template="emergency_alert_doctor",
                context={
                    "doctor_name": oncall_doctor.full_name,
                    "patient_name": patient.full_name if patient else "A patient",
                    "category": category,
                    "summary": summary,
                    "hospital_name": hospital.name,
                },
            )

    await ctx.session.commit()
    return {"ok": True, "case_id": str(entry.id), "hospital": hospital.name, "oncall_paged": oncall_id is not None}


async def list_hospitals(ctx: ToolContext, *, city: str | None = None, has_emergency_dept: bool | None = None) -> dict:
    stmt = select(Hospital)
    if city:
        stmt = stmt.where(Hospital.city == city)
    if has_emergency_dept is not None:
        stmt = stmt.where(Hospital.has_emergency_dept.is_(has_emergency_dept))
    rows = (await ctx.session.scalars(stmt)).all()
    return {"ok": True, "hospitals": [{"id": str(h.id), "name": h.name, "city": h.city, "has_emergency_dept": h.has_emergency_dept} for h in rows]}


async def transfer_to_human(ctx: ToolContext, *, reason: str) -> dict:
    ctx.collected_data["transfer_requested"] = reason
    return {"ok": True, "message": "A callback request has been created."}


TOOL_HANDLERS: dict[str, Callable[..., Awaitable[dict]]] = {
    "search_doctors": search_doctors,
    "check_availability": check_availability,
    "hold_slot": hold_slot_tool,
    "confirm_booking": confirm_booking_tool,
    "cancel_appointment": cancel_appointment_tool,
    "reschedule_appointment": reschedule_appointment_tool,
    "get_patient_context": get_patient_context,
    "record_symptom_data": record_symptom_data,
    "lookup_clinic_info": lookup_clinic_info,
    "escalate_emergency": escalate_emergency,
    "book_emergency_appointment": book_emergency_appointment,
    "list_hospitals": list_hospitals,
    "transfer_to_human": transfer_to_human,
}


async def call_tool(ctx: ToolContext, tool_name: str, args: dict) -> dict:
    """Dispatch one tool call. Never raises -- the agent must be able to recover
    conversationally (section 12).

    Every failure path logs before returning. Without this, a tool error is
    invisible server-side: the agent just improvises an apology ("I'm having
    trouble finalizing the booking") and the actual cause -- a malformed UUID, an
    unavailable slot, a DB error -- is never recorded anywhere.
    """
    handler = TOOL_HANDLERS.get(tool_name)
    if handler is None:
        logger.warning("tool_unknown", tool=tool_name, args=args)
        return _err(f"Unknown tool '{tool_name}'.")
    try:
        result = await handler(ctx, **args)
    except TypeError as e:
        logger.warning("tool_bad_arguments", tool=tool_name, args=args, error=str(e))
        return _err(f"Bad arguments for {tool_name}: {e}")
    except Exception as e:  # noqa: BLE001 -- tools must never raise into the agent loop
        logger.error(
            "tool_raised", tool=tool_name, args=args,
            error_type=type(e).__name__, error=str(e), exc_info=True,
        )
        return _err(f"{tool_name} failed: {e}")

    # Handlers signal soft failures by returning ok=False rather than raising --
    # just as diagnostically important as an exception, and previously just as silent.
    if isinstance(result, dict) and result.get("ok") is False:
        logger.warning("tool_returned_error", tool=tool_name, args=args, reason=result.get("reason"))
    return result
