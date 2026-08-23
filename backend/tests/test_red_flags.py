"""IMPLEMENTATION.md section 19 / Phase 6 gate: labelled corpus, recall >= 0.98,
negation suite. Positive cases use realistic patient phrasing (not copy-pasted
from red_flags.yaml's any_of lists) -- this is a deterministic phrase matcher, so
a recall gap here means the YAML corpus is missing a real phrasing, and the fix
is to add it there, not to loosen this test.
"""

import pytest

from app.safety.red_flags import match, match_timed, normalize

# (utterance(s), expected_category) -- utterance may be a list to exercise the
# 3-turn rolling window.
POSITIVE_CASES: list[tuple[list[str], str]] = [
    (["I have this crushing pain in my chest"], "cardiac"),
    (["My chest feels tight and heavy"], "cardiac"),
    (["There's a pain in my chest and it's going down my left arm"], "cardiac"),
    (["Seene mein dard ho raha hai"], "cardiac"),
    (["My face is drooping on one side"], "neuro"),
    (["I can't lift my arm and my speech feels slurred"], "neuro"),
    (["He suddenly can't speak properly and his face looks off"], "neuro"),
    (["My vision went suddenly in one eye"], "neuro"),
    (["I can't breathe, it's really bad"], "respiratory"),
    (["She's gasping for air right now"], "respiratory"),
    (["His lips are turning blue and he's struggling to breathe"], "respiratory"),
    (["My throat is closing up, I think it's an allergic reaction"], "allergic"),
    (["Her face is swelling up after the bee sting"], "allergic"),
    (["The bleeding won't stop, it's been ten minutes"], "trauma"),
    (["There's blood everywhere, cannot stop the bleeding"], "trauma"),
    (["He passed out and isn't waking up"], "neuro"),
    (["She fainted and is unresponsive"], "neuro"),
    (["My son is having a seizure right now"], "neuro"),
    (["She's convulsing on the floor"], "neuro"),
    (["I think I took too many pills"], "toxicology"),
    (["He swallowed poison, we don't know how much"], "toxicology"),
    (["I'm pregnant and bleeding heavily"], "obstetric"),
    (["My baby has a fever, she's two months old"], "pediatric"),
    (["The newborn fever started this morning"], "pediatric"),
    (["I fell from the roof and can't move my leg"], "trauma"),
    (["We were in a car accident just now"], "trauma"),
    (["He has a severe burn covering his arm"], "trauma"),
    (["This is the worst stomach pain of my life and my abdomen is rigid"], "abdominal"),
    (["I want to end my life"], "mental_health"),
    (["I've been thinking about suicide lately"], "mental_health"),
    (["I just don't want to live anymore"], "mental_health"),
    # Symptom described across a few turns (rolling window), not one sentence.
    (["I've had some discomfort today.", "It's in my chest actually.", "And now it's crushing pain, hard to breathe too."], "cardiac"),
]

# Should NOT fire -- explicit denial or resolved symptom (section 9.1's own examples).
NEGATION_CASES: list[list[str]] = [
    ["No chest pain at all, just some tiredness"],
    ["The chest pain stopped yesterday, I'm fine now"],
    ["I don't have any chest pressure"],
    ["She denies any chest pain or shortness of breath"],
    ["No slurred speech, no weakness, just a mild headache"],
    ["The bleeding has resolved now, it stopped an hour ago"],
    ["He is not having a seizure, that was last month and it's over"],
    ["I'm not thinking about hurting myself, just feeling a bit low"],
    ["No fever in the baby, she's totally fine"],
    ["Negative for any allergic reaction, just a mild rash"],
]

# Should NOT fire -- unrelated, mundane conversation.
BENIGN_CASES: list[list[str]] = [
    ["I'd like to book an appointment for next Tuesday"],
    ["What are your clinic hours on weekends"],
    ["I have a mild cough for two days, nothing serious"],
    ["Can I reschedule my appointment with Dr. Rao"],
    ["My knee has been a bit sore after running"],
    ["I need a refill on my blood pressure medication"],
]


@pytest.mark.parametrize("utterances,expected_category", POSITIVE_CASES)
def test_positive_cases_fire_with_correct_category(utterances, expected_category):
    hit = match(utterances)
    assert hit is not None, f"expected a red-flag match for {utterances!r}"
    assert hit.category == expected_category, f"expected category {expected_category!r}, got {hit.category!r} for {utterances!r}"


@pytest.mark.parametrize("utterances", NEGATION_CASES)
def test_negation_cases_do_not_fire(utterances):
    hit = match(utterances)
    assert hit is None, f"expected no match (negated) for {utterances!r}, got {hit}"


@pytest.mark.parametrize("utterances", BENIGN_CASES)
def test_benign_cases_do_not_fire(utterances):
    hit = match(utterances)
    assert hit is None, f"expected no match (benign) for {utterances!r}, got {hit}"


def test_recall_meets_threshold():
    hits = sum(1 for utterances, _ in POSITIVE_CASES if match(utterances) is not None)
    recall = hits / len(POSITIVE_CASES)
    assert recall >= 0.98, f"recall {recall:.3f} below the 0.98 threshold ({hits}/{len(POSITIVE_CASES)})"


def test_runs_under_five_milliseconds():
    utterances = ["I've had a crushing pain in my chest since this morning, radiating to my arm"]
    # First call pays for lru_cache-loading the YAML; time the second.
    match(utterances)
    _, elapsed_ms = match_timed(utterances)
    assert elapsed_ms < 5.0, f"red flag match took {elapsed_ms:.2f}ms, over the 5ms budget"


def test_normalize_strips_apostrophes_to_match_yaml_phrasing():
    assert "cant" in normalize("I can't breathe")
    assert "'" not in normalize("I can't breathe")


def test_turn_boundary_prevents_cross_turn_negation_leak():
    # "no chest pain" in turn 1 must not suppress a genuine mention in turn 2 --
    # the negation window must not reach backward across a turn boundary.
    hit = match(["No chest pain earlier", "But now I have crushing pain in my chest"])
    assert hit is not None
    assert hit.category == "cardiac"


def test_empty_and_whitespace_input_is_safe():
    assert match([]) is None
    assert match([""]) is None
    assert match(["   "]) is None
