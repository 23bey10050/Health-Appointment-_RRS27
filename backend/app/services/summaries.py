"""AI summary generation and the doctor approval workflow -- IMPLEMENTATION.md
sections 11.3-11.5 and SAFETY-3: "No LLM-generated clinical content reaches a
patient without clinician approval. Post-visit summaries enter state 'draft'. A
doctor must review and explicitly approve (or edit) them before the system emails
them. Pre-visit summaries are doctor-facing only."

Every generation path here is total: on any failure (no provider keys, malformed
JSON after repair, everything down) it still returns a persisted AISummary row with
state='failed' and generation_error set, never a 500 and never a half-written
artifact (section 11 preamble).
"""

import uuid
from datetime import UTC, datetime

from redis.asyncio import Redis
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import ConflictError, NotFoundError
from app.llm.generate import generate_structured
from app.llm.prompt_loader import render_prompt
from app.llm.redact import redact_for_session, rehydrate_model
from app.llm.router import Tier
from app.llm.schemas import PostVisitSummary, PreVisitSummary, TriageResult
from app.models.appointment import Appointment
from app.models.encounter import AISummary, Encounter, Prescription
from app.models.enums import SummaryKind, SummaryState
from app.models.user import PatientProfile, User
from app.models.voice import VoiceSession, VoiceTurn
from app.services.notification import enqueue_email

REASON_SYSTEM_PROMPT = "You are a clinical documentation assistant. Follow the instructions exactly and return only the requested JSON."


def _patient_known_values(patient: User) -> dict[str, str]:
    return {"name": patient.full_name, "phone": patient.phone or "", "email": patient.email}


async def generate_triage(
    redis: Redis,
    *,
    session_key: str,
    symptoms: str,
    patient_history: str,
    retrieved_chunks: str,
    known_values: dict[str, str],
) -> tuple[TriageResult | None, str | None, dict]:
    """Returns (result, generation_error, provenance). Not persisted here -- the
    voice orchestrator (Phase 5) owns where a triage result lives (voice_sessions
    vs. an ai_summary); this function is pure generation."""
    symptoms_r = await redact_for_session(redis, session_key, symptoms, known_values=known_values)
    history_r = await redact_for_session(redis, session_key, patient_history, known_values=known_values)

    prompt, prompt_version = render_prompt(
        "triage", "v1", symptoms=symptoms_r, patient_history=history_r, retrieved_chunks=retrieved_chunks
    )
    result = await generate_structured(
        Tier.REASON, TriageResult, system_prompt=REASON_SYSTEM_PROMPT, user_prompt=prompt, prompt_version=prompt_version
    )
    if result.data is None:
        return None, result.generation_error, _provenance(result)

    rehydrated = await rehydrate_model(redis, session_key, result.data)
    return rehydrated, None, _provenance(result)


def _provenance(result) -> dict:
    return {
        "model_provider": result.provider,
        "model_name": result.model,
        "prompt_version": result.prompt_version,
        "input_token_count": result.input_tokens,
        "output_token_count": result.output_tokens,
        "latency_ms": result.latency_ms,
    }


async def generate_pre_visit_summary(session: AsyncSession, redis: Redis, appointment_id: uuid.UUID) -> AISummary:
    appointment = await session.get(Appointment, appointment_id)
    if appointment is None:
        raise NotFoundError("Appointment not found")

    voice_session = await session.scalar(
        select(VoiceSession).where(VoiceSession.appointment_id == appointment_id)
    )
    turns_text = ""
    if voice_session is not None:
        turns = (
            await session.scalars(
                select(VoiceTurn).where(VoiceTurn.session_id == voice_session.id).order_by(VoiceTurn.turn_index)
            )
        ).all()
        turns_text = "\n".join(f"{t.speaker}: {t.transcript}" for t in turns if t.transcript)

    patient = await session.get(User, appointment.patient_id)
    session_key = f"appointment:{appointment_id}"
    known_values = _patient_known_values(patient) if patient else {}

    transcript_r = await redact_for_session(redis, session_key, turns_text, known_values=known_values)
    triage_r = await redact_for_session(
        redis, session_key, str((voice_session.collected_data or {}).get("triage", "")) if voice_session else "",
        known_values=known_values,
    )

    # Patient context was previously passed as "" -- so for any appointment booked
    # through the web UI (no voice transcript) the model received nothing at all
    # and dutifully returned a summary with every field blank, which the doctor
    # portal then rendered as an empty panel. Allergies, chronic conditions,
    # current medications and the stated booking reason are useful to a preparing
    # clinician even with no transcript, so they go in here.
    profile = await session.get(PatientProfile, appointment.patient_id)
    context_parts: list[str] = []
    if appointment.reason_text:
        context_parts.append(f"Reason given at booking: {appointment.reason_text}")
    if profile:
        if profile.allergies:
            context_parts.append(f"Known allergies: {', '.join(profile.allergies)}")
        if profile.chronic_conditions:
            context_parts.append(f"Chronic conditions: {', '.join(profile.chronic_conditions)}")
        if profile.current_medications:
            context_parts.append(f"Current medications: {', '.join(profile.current_medications)}")
    patient_context_r = await redact_for_session(
        redis, session_key, "\n".join(context_parts), known_values=known_values
    )

    # Nothing to summarise at all: no transcript, no stated reason, no history.
    # Generating here would burn two REASON-tier calls to produce a blank draft.
    if not turns_text and not context_parts:
        summary = AISummary(
            kind=SummaryKind.pre_visit,
            appointment_id=appointment_id,
            state=SummaryState.failed,
            content={},
            generation_error="No pre-visit information available (no voice intake, booking reason, or recorded history).",
        )
        session.add(summary)
        await session.commit()
        await session.refresh(summary)
        return summary

    prompt, prompt_version = render_prompt(
        "pre_visit_summary",
        "v1",
        transcript=transcript_r or "No voice transcript is available for this appointment.",
        triage_result=triage_r or "Not available.",
        patient_context=patient_context_r or "No additional history on file.",
    )
    result = await generate_structured(
        Tier.REASON, PreVisitSummary, system_prompt=REASON_SYSTEM_PROMPT, user_prompt=prompt, prompt_version=prompt_version
    )

    data = None
    if result.data is not None:
        rehydrated = await rehydrate_model(redis, session_key, result.data)
        data = rehydrated.model_dump()

    summary = AISummary(
        kind=SummaryKind.pre_visit,
        appointment_id=appointment_id,
        state=SummaryState.draft if data is not None else SummaryState.failed,
        content=data or {},
        generation_error=result.generation_error,
        **_provenance(result),
    )
    session.add(summary)
    await session.commit()
    await session.refresh(summary)
    return summary


async def generate_post_visit_summary(session: AsyncSession, redis: Redis, encounter_id: uuid.UUID) -> AISummary:
    encounter = await session.get(Encounter, encounter_id)
    if encounter is None:
        raise NotFoundError("Encounter not found")
    appointment = await session.get(Appointment, encounter.appointment_id)
    patient = await session.get(User, appointment.patient_id) if appointment else None
    prescriptions = (
        await session.scalars(select(Prescription).where(Prescription.encounter_id == encounter_id))
    ).all()

    session_key = f"encounter:{encounter_id}"
    known_values = _patient_known_values(patient) if patient else {}

    notes_r = await redact_for_session(redis, session_key, encounter.clinical_notes or "", known_values=known_values)
    prescriptions_text = "\n".join(
        f"{p.drug_name} {p.strength or ''}, {p.frequency_code}, {p.duration_days} days, {p.instructions or ''}"
        for p in prescriptions
    )
    follow_up = f"Follow up in {encounter.follow_up_after_days} days" if encounter.follow_up_after_days else "None specified"

    prompt, prompt_version = render_prompt(
        "post_visit_summary", "v1", notes=notes_r, prescriptions=prescriptions_text or "None prescribed.", follow_up=follow_up
    )
    result = await generate_structured(
        Tier.REASON, PostVisitSummary, system_prompt=REASON_SYSTEM_PROMPT, user_prompt=prompt, prompt_version=prompt_version
    )

    data = None
    if result.data is not None:
        rehydrated = await rehydrate_model(redis, session_key, result.data)
        data = rehydrated.model_dump()

    summary = AISummary(
        kind=SummaryKind.post_visit,
        appointment_id=encounter.appointment_id,
        encounter_id=encounter_id,
        state=SummaryState.draft if data is not None else SummaryState.failed,
        content=data or {},
        generation_error=result.generation_error,
        **_provenance(result),
    )
    session.add(summary)
    await session.commit()
    await session.refresh(summary)
    return summary


async def approve_summary(
    session: AsyncSession, summary_id: uuid.UUID, reviewer_id: uuid.UUID, edited_content: dict | None = None
) -> AISummary:
    summary = await session.get(AISummary, summary_id)
    if summary is None:
        raise NotFoundError("Summary not found")
    # A 'failed' summary is approvable only via manual entry (edited_content) --
    # section 11's "surface a manual-entry UI" recovery path. Approving a failed
    # generation with no content to replace it would be shipping an empty artifact.
    approvable = summary.state in (SummaryState.draft, SummaryState.edited) or (
        summary.state == SummaryState.failed and edited_content is not None
    )
    if not approvable:
        raise ConflictError(f"Cannot approve a summary in state '{summary.state.value}'")

    summary.reviewed_by = reviewer_id
    summary.reviewed_at = datetime.now(UTC)
    if edited_content is not None:
        summary.content_edited = edited_content
        summary.state = SummaryState.edited
    else:
        summary.state = SummaryState.approved

    # SAFETY-3: only now, after explicit clinician approval, does a post-visit
    # summary become an email. Pre-visit summaries are doctor-facing only -- never
    # emailed to the patient, regardless of state.
    if summary.kind == SummaryKind.post_visit:
        appointment = await session.get(Appointment, summary.appointment_id) if summary.appointment_id else None
        patient = await session.get(User, appointment.patient_id) if appointment else None
        doctor = await session.get(User, appointment.doctor_id) if appointment else None
        if patient:
            content = summary.content_edited or summary.content
            await enqueue_email(
                session,
                idempotency_key=f"post_visit_summary:{summary.id}",
                to_email=patient.email,
                template="post_visit_summary",
                context={
                    "patient_name": patient.full_name,
                    "doctor_name": doctor.full_name if doctor else "your doctor",
                    **content,
                },
            )

    await session.commit()
    await session.refresh(summary)
    return summary


async def reject_summary(session: AsyncSession, summary_id: uuid.UUID, reviewer_id: uuid.UUID) -> AISummary:
    summary = await session.get(AISummary, summary_id)
    if summary is None:
        raise NotFoundError("Summary not found")
    summary.state = SummaryState.rejected
    summary.reviewed_by = reviewer_id
    summary.reviewed_at = datetime.now(UTC)
    await session.commit()
    await session.refresh(summary)
    return summary
