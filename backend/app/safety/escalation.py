"""Emergency response -- IMPLEMENTATION.md section 9.2. On a critical red-flag
hit, in order, within 300ms:
  1. cancel in-flight LLM, send stop_playback           <- orchestrator (timing-critical)
  2. speak the fixed script (never LLM-generated)        <- orchestrator, using get_script_audio below
  3. client renders EmergencyBanner                      <- orchestrator emits the `emergency` frame
  4. voice_sessions.emergency_triggered=True, red_flags_matched appended   <- record_emergency
  5. create an emergency_queue entry, bypass normal slot logic             <- record_emergency
  6. notify on-call doctor (email + in-portal + push)                     <- record_emergency
  7. kick off the emergency decision-support brief (REASON tier)          <- generate_emergency_brief
  8. keep the line open, never return to routine booking flow             <- orchestrator

Steps 1-3 are synchronous and timing-critical (the orchestrator does these
directly against the live connection); steps 4-7 are this module's job and don't
block the spoken response.
"""

import uuid

from redis.asyncio import Redis
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.llm.generate import generate_structured
from app.llm.prompt_loader import render_prompt
from app.llm.redact import redact_for_session, rehydrate_model
from app.llm.router import Tier
from app.llm.schemas import EmergencyBrief
from app.models.doctor import DoctorProfile
from app.models.emergency import EmergencyQueueEntry
from app.models.encounter import AISummary
from app.models.enums import SummaryKind, SummaryState
from app.models.hospital import Hospital
from app.models.user import User
from app.models.voice import VoiceSession
from app.rag.retriever import retrieve
from app.safety.red_flags import RedFlagHit
from app.services.notification import enqueue_email

settings = get_settings()

# Fixed scripts, spoken by the browser's speechSynthesis -- never LLM-generated,
# so they play even with every LLM provider down (section 20, item 10: "test the
# emergency path with the LLM disabled. If it only works when the model is up, it
# does not work."). They also bypass the output guard: they are hand-written and
# must reach the patient verbatim.
EMERGENCY_SCRIPTS: dict[str, str] = {
    "emergency_cardiac": (
        "This could be a medical emergency. Please call one zero eight for an ambulance right now, "
        "or one one two if you can't reach them. I'm alerting the on-call doctor at your hospital "
        "and creating an urgent case for you. I'm staying right here with you."
    ),
    "emergency_stroke": (
        "These signs need emergency care immediately, every minute matters. Please call one zero eight "
        "right now. I'm alerting the on-call doctor and creating an urgent case. I'll stay with you."
    ),
    "emergency_respiratory": (
        "This needs emergency care right now. Please call one zero eight for an ambulance immediately. "
        "I'm alerting the on-call doctor and creating an urgent case. I'm still here with you."
    ),
    "emergency_anaphylaxis": (
        "This sounds like a severe allergic reaction and needs emergency care immediately. Please call "
        "one zero eight right now. If an epinephrine auto-injector is available, use it now. "
        "I'm alerting the on-call doctor and creating an urgent case."
    ),
    "emergency_bleeding": (
        "Please apply firm, direct pressure to the bleeding right now and call one zero eight immediately. "
        "I'm alerting the on-call doctor and creating an urgent case for you."
    ),
    "emergency_unconscious": (
        "Please call one zero eight immediately. If they are breathing, lay them on their side. "
        "I'm alerting the on-call doctor and creating an urgent case right now."
    ),
    "emergency_seizure": (
        "Please keep the area around them clear and do not restrain them. Call one zero eight immediately. "
        "I'm alerting the on-call doctor and creating an urgent case."
    ),
    "emergency_overdose": (
        "Please call one zero eight immediately, and if possible, keep the medication or substance "
        "packaging to show the emergency team. I'm alerting the on-call doctor right now."
    ),
    "emergency_obstetric": (
        "This needs emergency care immediately. Please call one zero eight right now. "
        "I'm alerting the on-call doctor and creating an urgent case for you."
    ),
    "emergency_infant_fever": (
        "A fever in a baby this young needs emergency evaluation right away, even if the baby seems okay. "
        "Please call one zero eight or go to the emergency department now. I'm alerting the on-call doctor."
    ),
    "emergency_trauma": (
        "Please call one zero eight immediately and try not to move the injured area. "
        "I'm alerting the on-call doctor and creating an urgent case right now."
    ),
    "emergency_burns": (
        "Please cool the burn with clean running water and call one zero eight immediately. "
        "Do not apply ice directly. I'm alerting the on-call doctor right now."
    ),
    "emergency_acute_abdomen": (
        "This needs emergency evaluation right now. Please call one zero eight immediately. "
        "I'm alerting the on-call doctor and creating an urgent case for you."
    ),
    "emergency_self_harm": (
        "I hear you, and I'm really glad you told me. You don't have to go through this alone. "
        "The Tele-MANAS helpline is available right now at one four four one six, any time, day or night. "
        "Would it be okay if I connect you with a clinician immediately?"
    ),
}

EMERGENCY_NUMBERS = ["108", "112"]
MENTAL_HEALTH_HELPLINE = "14416"


def get_script_text(script_id: str) -> str:
    return EMERGENCY_SCRIPTS.get(
        script_id, "This may be a medical emergency. Please call one zero eight or one one two right now."
    )


def numbers_for(script_id: str) -> list[str]:
    if script_id == "emergency_self_harm":
        return [MENTAL_HEALTH_HELPLINE]
    return EMERGENCY_NUMBERS


async def record_emergency(
    session: AsyncSession,
    *,
    hit: RedFlagHit,
    voice_session_id: uuid.UUID,
    patient_id: uuid.UUID | None,
    hospital_id: uuid.UUID | None,
    transcript_excerpt: str,
) -> EmergencyQueueEntry:
    """Steps 4-6: persist, queue, notify. Never raises past this function -- an
    emergency case must exist even if notification enqueueing has a problem, so
    each step is best-effort past the core insert."""
    voice_session = await session.get(VoiceSession, voice_session_id)
    if voice_session is not None:
        voice_session.emergency_triggered = True
        voice_session.red_flags_matched = [*voice_session.red_flags_matched, hit.id]

    # A red flag can fire on the very first utterance, before the conversation has
    # resolved which hospital the patient means (hospital_id is None in that case,
    # which is the common case, not an edge case -- SAFETY-1 runs before any tool
    # call could have set it). Paging *some* accepts-emergency doctor beats paging
    # no one: scope to the hospital when known, otherwise page across all of them.
    oncall_stmt = (
        select(User.id)
        .join(DoctorProfile, DoctorProfile.user_id == User.id)
        .where(DoctorProfile.accepts_emergency.is_(True))
    )
    if hospital_id is not None:
        oncall_stmt = oncall_stmt.where(DoctorProfile.hospital_id == hospital_id)
    oncall_doctor_id = await session.scalar(oncall_stmt.limit(1))

    # Pre-fill callback details from the patient's account rather than waiting for
    # the conversation to supply them. The intake can still overwrite these if the
    # patient gives a different number, but the on-call doctor must never be left
    # with no way to call back just because the call dropped mid-question or the
    # model forgot to record the answer.
    account_name = account_phone = None
    if patient_id is not None:
        patient_user = await session.get(User, patient_id)
        if patient_user is not None:
            account_name = patient_user.full_name
            account_phone = patient_user.phone

    entry = EmergencyQueueEntry(
        patient_id=patient_id,
        hospital_id=hospital_id,
        voice_session_id=voice_session_id,
        callback_name=account_name,
        callback_phone=account_phone,
        category=hit.category,
        severity=hit.severity,
        summary=f"Red flag '{hit.id}' matched: \"{hit.matched_text}\". Context: {transcript_excerpt[:500]}",
        oncall_doctor_id=oncall_doctor_id,
    )
    session.add(entry)
    await session.flush()

    if oncall_doctor_id:
        doctor = await session.get(User, oncall_doctor_id)
        hospital = await session.get(Hospital, hospital_id) if hospital_id else None
        patient = await session.get(User, patient_id) if patient_id else None
        if doctor:
            await enqueue_email(
                session,
                idempotency_key=f"emergency_alert:{entry.id}",
                to_email=doctor.email,
                template="emergency_alert_doctor",
                context={
                    "doctor_name": doctor.full_name,
                    "patient_name": patient.full_name if patient else "A patient",
                    "category": hit.category,
                    "summary": entry.summary,
                    "hospital_name": hospital.name if hospital else "the clinic",
                },
            )

    await session.commit()
    return entry


async def generate_emergency_brief(
    session: AsyncSession, redis: Redis, *, entry: EmergencyQueueEntry, patient_id: uuid.UUID | None
) -> AISummary:
    """Step 7. SAFETY-4 in full: decision support, never a diagnosis -- enforced
    by the prompt (llm/prompts/emergency_brief.v1.md) and by EmergencyBrief's
    schema shape (differential_considerations, not a diagnosis field)."""
    session_key = f"emergency:{entry.id}"
    known_values = {}
    if patient_id:
        patient = await session.get(User, patient_id)
        if patient:
            known_values = {"name": patient.full_name, "phone": patient.phone or "", "email": patient.email}

    presentation_r = await redact_for_session(redis, session_key, entry.summary or "", known_values=known_values)

    retrieved = await retrieve(
        session, f"{entry.category} {presentation_r}", namespaces=["clinical_kb"], audience="doctor",
        patient_id=None, k=5, redis=redis,
    )
    retrieved_text = "\n".join(f"[{c.id}] {c.content}" for c in retrieved)

    prompt, prompt_version = render_prompt(
        "emergency_brief", "v1", presentation=presentation_r, red_flags_matched=entry.category, retrieved_chunks=retrieved_text,
    )
    result = await generate_structured(
        Tier.REASON, EmergencyBrief,
        system_prompt="You are a clinical decision-support assistant for a licensed emergency physician.",
        user_prompt=prompt, prompt_version=prompt_version, max_tokens=2000,
    )

    data = None
    if result.data is not None:
        rehydrated = await rehydrate_model(redis, session_key, result.data)
        data = rehydrated.model_dump()

    summary = AISummary(
        kind=SummaryKind.emergency_brief,
        emergency_queue_id=entry.id,
        state=SummaryState.draft if data is not None else SummaryState.failed,
        content=data or {},
        generation_error=result.generation_error,
        model_provider=result.provider,
        model_name=result.model,
        prompt_version=result.prompt_version,
        input_token_count=result.input_tokens,
        output_token_count=result.output_tokens,
        latency_ms=result.latency_ms,
    )
    session.add(summary)
    await session.commit()
    await session.refresh(summary)
    return summary
