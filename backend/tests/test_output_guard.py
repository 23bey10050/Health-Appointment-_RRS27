"""IMPLEMENTATION.md section 19: planted diagnostic and prescriptive responses are
blocked. SAFETY-2: the patient-facing agent never diagnoses, never names drugs.
"""

import pytest

from app.safety.output_guard import SAFE_FALLBACK_LINE, guard

DIAGNOSTIC_PLANTS = [
    "Based on what you've described, you have a stomach ulcer.",
    "It sounds like you're suffering from a migraine.",
    "This is likely appendicitis given the location of the pain.",
    "You might have a urinary tract infection.",
    "My diagnosis is that this is a viral infection.",
    "You're diagnosed with mild hypertension based on your symptoms.",
]

PRESCRIPTIVE_PLANTS = [
    "You should take 500 mg of paracetamol every six hours.",
    "Take two tablets of ibuprofen with food.",
    "I recommend taking an antacid before meals.",
    "You can take an antihistamine for the itching.",
    "Take 10ml of the syrup twice a day.",
]

SAFE_RESPONSES = [
    "Thanks for sharing that. How long has this been going on?",
    "I've noted your symptoms -- Dr. Mehta will review them at your visit.",
    "Your appointment with Dr. Rao is confirmed for Tuesday at ten thirty.",
    "I'm not able to advise on that -- your doctor will go through it with you at the visit.",
    "Let me check what times are available this week.",
    # Regressions observed in live conversation: the guard was blocking the agent
    # for asking about symptoms and for confirming a booking, which derailed the
    # whole flow. Asking is not diagnosing, and reflecting a symptom back is not
    # diagnosing either.
    "I still need to know what main symptoms you are experiencing so the doctor can prepare.",
    "What symptoms are you experiencing at the moment?",
    "So you're experiencing chest pain once a day -- how long has that been happening?",
    "Okay, that is booked for you.",
    "Great, that is confirmed for tomorrow morning.",
    "How long have you had this for?",
    "Do you have any other symptoms along with the headache, like nausea or sensitivity to light?",
    "Do you have a fever as well?",
    "Have you had this before?",
    "Mild and comes and goes since yesterday, got it. Do you have any other symptoms?",
    "Are you experiencing any breathlessness with it?",
]


@pytest.mark.parametrize("text", DIAGNOSTIC_PLANTS)
def test_diagnostic_language_is_blocked(text):
    assert guard(text) == SAFE_FALLBACK_LINE


@pytest.mark.parametrize("text", PRESCRIPTIVE_PLANTS)
def test_prescriptive_language_is_blocked(text):
    assert guard(text) == SAFE_FALLBACK_LINE


@pytest.mark.parametrize("text", SAFE_RESPONSES)
def test_safe_responses_pass_through_unchanged(text):
    assert guard(text) == text


# The question exemption is per-sentence, so an assertion elsewhere in a
# multi-sentence reply must still be caught.
MIXED_QUESTION_AND_ASSERTION = [
    "How long has this been going on? You have a urinary tract infection.",
    "Do you have a fever? This is likely appendicitis.",
    "Any nausea with it? You should take 500 mg of paracetamol.",
]


@pytest.mark.parametrize("text", MIXED_QUESTION_AND_ASSERTION)
def test_assertion_after_a_question_is_still_blocked(text):
    assert guard(text) == SAFE_FALLBACK_LINE
