"""Strict JSON contracts for every structured LLM call -- IMPLEMENTATION.md section
11. Every generation endpoint validates the model's output against one of these,
repairs once on failure, falls back to the next provider on a second failure, and
gives up cleanly (state='failed') rather than ever showing a half-parsed artifact
(section 11 preamble).
"""

from pydantic import BaseModel, Field

UrgencyLiteral = str  # "low" | "medium" | "high" | "critical" -- validated by callers against UrgencyLevel


class TriageResult(BaseModel):
    """Section 11.2."""

    urgency: UrgencyLiteral
    chief_complaint: str = Field(max_length=120)
    recommended_specialisation: str
    alternative_specialisations: list[str] = Field(default_factory=list)
    key_findings: list[str] = Field(default_factory=list)
    questions_for_doctor: list[str] = Field(default_factory=list)
    information_gaps: list[str] = Field(default_factory=list)
    confidence: float = Field(ge=0.0, le=1.0)
    reasoning: str


class SymptomTimelineEntry(BaseModel):
    when: str
    what: str


class PreVisitSummary(BaseModel):
    """Section 11.3. Doctor-facing only (SAFETY-3 concerns post-visit, not this)."""

    chief_complaint: str
    urgency: UrgencyLiteral
    hpi: str
    symptom_timeline: list[SymptomTimelineEntry] = Field(default_factory=list)
    relevant_history: list[str] = Field(default_factory=list)
    current_medications: list[str] = Field(default_factory=list)
    allergies: list[str] = Field(default_factory=list)
    red_flags_noted: list[str] = Field(default_factory=list)
    red_flags_explicitly_denied: list[str] = Field(default_factory=list)
    questions_for_doctor: list[str] = Field(default_factory=list)
    information_gaps: list[str] = Field(default_factory=list)
    patient_own_words: str


class DifferentialConsideration(BaseModel):
    """SAFETY-4: 'consider / cannot exclude', never a diagnosis."""

    consideration: str
    supporting_features: list[str] = Field(default_factory=list)
    features_against: list[str] = Field(default_factory=list)
    cannot_exclude_because: list[str] = Field(default_factory=list)
    time_criticality: str  # "immediate" | "urgent" | "routine"
    suggested_workup: list[str] = Field(default_factory=list)
    source_refs: list[str] = Field(default_factory=list)


class EmergencyBrief(BaseModel):
    """Section 11.4. SAFETY-4 applies in full -- decision support, never a diagnosis."""

    presentation_summary: str
    vital_concerns: list[str] = Field(default_factory=list)
    differential_considerations: list[DifferentialConsideration] = Field(default_factory=list)
    immediate_actions_to_consider: list[str] = Field(default_factory=list)
    information_needed_urgently: list[str] = Field(default_factory=list)
    confidence: float = Field(ge=0.0, le=1.0)
    limitations: str


class MedicationScheduleEntry(BaseModel):
    drug: str
    dose: str
    when: str
    with_food: str = ""
    for_how_long: str = ""
    why: str = ""


class PatientQuestion(BaseModel):
    q: str
    a: str


class PostVisitSummary(BaseModel):
    """Section 11.5. SAFETY-3: state='draft' until a doctor approves -- never
    emailed on generation alone (see services/summaries.py)."""

    what_we_discussed: str
    what_the_doctor_found: str = ""
    medication_schedule: list[MedicationScheduleEntry] = Field(default_factory=list)
    things_to_do: list[str] = Field(default_factory=list)
    things_to_avoid: list[str] = Field(default_factory=list)
    come_back_if: list[str] = Field(default_factory=list)
    next_appointment: str | None = None
    questions_you_might_have: list[PatientQuestion] = Field(default_factory=list)
