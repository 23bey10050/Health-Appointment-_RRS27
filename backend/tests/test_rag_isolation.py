"""IMPLEMENTATION.md section 19 / SAFETY-5: patient audience never retrieves
clinical_kb; patient A never retrieves patient B's patient_ctx. Asserts on
returned chunk ids, not model output -- the whole point of SAFETY-5 is that this
holds at the SQL level regardless of what an LLM would do with the chunks.

Embeddings here are synthetic (not real fastembed output) -- this test exercises
the audience/patient_id SQL filter, not semantic ranking, so a fixed dummy vector
is enough and keeps the suite from depending on the embedding model being warm.
"""

import uuid

import pytest

from app.models.kb import KBChunk, KBDocument
from app.rag.retriever import retrieve

DUMMY_VECTOR = [0.01] * 384


async def _make_document(session, *, namespace, audience, title, patient_id=None):
    doc = KBDocument(namespace=namespace, audience=audience, title=title, patient_id=patient_id)
    session.add(doc)
    await session.flush()
    return doc


async def _make_chunk(session, document, *, content, patient_id=None, chunk_index=0):
    chunk = KBChunk(
        document_id=document.id,
        namespace=document.namespace,
        audience=document.audience,
        patient_id=patient_id,
        chunk_index=chunk_index,
        content=content,
        heading_path=None,
        embedding=DUMMY_VECTOR,
        token_count=len(content.split()),
    )
    session.add(chunk)
    await session.flush()
    return chunk


@pytest.mark.asyncio
async def test_patient_audience_never_sees_clinical_kb(db_session):
    clinical_doc = await _make_document(
        db_session, namespace="clinical_kb", audience="doctor", title="Differentials"
    )
    clinical_chunk = await _make_chunk(
        db_session, clinical_doc, content="Consider acute coronary syndrome for chest pain with radiation."
    )

    clinic_doc = await _make_document(db_session, namespace="clinic_kb", audience="both", title="FAQ")
    clinic_chunk = await _make_chunk(db_session, clinic_doc, content="Chest pain during a visit should be reported immediately.")
    await db_session.commit()

    results = await retrieve(
        db_session,
        "what could be causing my chest pain",
        namespaces=["clinical_kb", "clinic_kb"],
        audience="patient",
        patient_id=None,
        k=10,
    )
    result_ids = {r.id for r in results}

    assert clinical_chunk.id not in result_ids, "SAFETY-5 violated: clinical_kb chunk reached a patient-audience query"
    assert clinic_chunk.id in result_ids


@pytest.mark.asyncio
async def test_doctor_audience_can_see_clinical_kb(db_session):
    clinical_doc = await _make_document(
        db_session, namespace="clinical_kb", audience="doctor", title="Differentials"
    )
    clinical_chunk = await _make_chunk(db_session, clinical_doc, content="Consider pulmonary embolism.")
    await db_session.commit()

    results = await retrieve(
        db_session, "chest pain differential", namespaces=["clinical_kb"], audience="doctor", patient_id=None, k=10
    )
    assert clinical_chunk.id in {r.id for r in results}


@pytest.mark.asyncio
async def test_patient_a_never_sees_patient_b_context(db_session, seeded_patient):
    # kb_documents.patient_id is a real FK to users(id) (kb_chunks.patient_id is
    # not, per section 6.5 -- denormalised for filtering only). seeded_patient
    # gives one real user; a second is created inline the same way.
    from app.core.security import hash_password
    from app.models.enums import UserRole
    from app.models.user import User

    patient_a = seeded_patient
    user_b = User(
        email=f"patient-b-{uuid.uuid4().hex[:10]}@test.example",
        full_name="Test Patient B",
        password_hash=hash_password("irrelevant"),
        role=UserRole.patient,
    )
    db_session.add(user_b)
    await db_session.flush()
    patient_b = user_b.id

    doc_a = await _make_document(db_session, namespace="patient_ctx", audience="both", title="A's history", patient_id=patient_a)
    chunk_a = await _make_chunk(db_session, doc_a, content="Patient has a known penicillin allergy.", patient_id=patient_a)

    doc_b = await _make_document(db_session, namespace="patient_ctx", audience="both", title="B's history", patient_id=patient_b)
    chunk_b = await _make_chunk(db_session, doc_b, content="Patient has a known penicillin allergy.", patient_id=patient_b)
    await db_session.commit()

    results_for_a = await retrieve(
        db_session, "known allergies", namespaces=["patient_ctx"], audience="patient", patient_id=patient_a, k=10
    )
    ids_for_a = {r.id for r in results_for_a}

    assert chunk_a.id in ids_for_a
    assert chunk_b.id not in ids_for_a, "SAFETY-5 violated: patient A's query returned patient B's context"


@pytest.mark.asyncio
async def test_namespace_not_requested_is_excluded_even_if_audience_matches(db_session):
    """Defense in depth check: even a chunk with the right audience shouldn't
    surface if the caller didn't ask for its namespace."""
    clinic_doc = await _make_document(db_session, namespace="clinic_kb", audience="both", title="FAQ")
    clinic_chunk = await _make_chunk(db_session, clinic_doc, content="Our cancellation policy is flexible.")
    await db_session.commit()

    results = await retrieve(
        db_session, "cancellation policy", namespaces=["triage_kb"], audience="patient", patient_id=None, k=10
    )
    assert clinic_chunk.id not in {r.id for r in results}
