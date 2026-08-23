"""Loads app/rag/seed/* into kb_documents/kb_chunks -- IMPLEMENTATION.md section
8.5. Idempotent: re-running replaces each document's chunks (rag/ingest.py).

Run inside the api container: `python -m scripts.seed_kb`
"""

import asyncio
from pathlib import Path

import yaml

from app.db.session import SessionLocal
from app.rag.ingest import ingest_chunks, ingest_markdown
from app.rag.seed_yaml import (
    clarifying_questions_chunks,
    red_flag_definitions_chunks,
    specialisation_routing_chunks,
)

SEED_DIR = Path(__file__).resolve().parent.parent / "app" / "rag" / "seed"

MARKDOWN_SOURCES = [
    ("clinic_policies.md", "clinic_kb", "both", "Clinic Policies"),
    ("insurance_and_billing.md", "clinic_kb", "both", "Insurance and Billing"),
    ("visit_preparation.md", "clinic_kb", "both", "Visit Preparation"),
    ("faq.md", "clinic_kb", "both", "Frequently Asked Questions"),
    ("appointment_types.md", "clinic_kb", "both", "Appointment Types"),
    # Worked triage examples -- triage_kb so they surface when the agent is
    # deciding urgency, alongside the routing and red-flag definitions.
    ("triage_scenarios.md", "triage_kb", "both", "Worked Triage Scenarios"),
    ("clinical_differentials.md", "clinical_kb", "doctor", "Clinical Differential Frameworks"),
    ("workup_protocols.md", "clinical_kb", "doctor", "Standard Workup Protocols"),
]

YAML_SOURCES = [
    ("specialisation_routing.yaml", "triage_kb", "both", "Specialisation Routing", specialisation_routing_chunks),
    ("red_flag_definitions.yaml", "triage_kb", "both", "Red Flag Definitions", red_flag_definitions_chunks),
    ("clarifying_questions.yaml", "triage_kb", "both", "Clarifying Questions", clarifying_questions_chunks),
]


async def seed() -> None:
    total_chunks = 0
    async with SessionLocal() as session:
        for filename, namespace, audience, title in MARKDOWN_SOURCES:
            path = SEED_DIR / filename
            text = path.read_text(encoding="utf-8")
            count = await ingest_markdown(
                session, namespace=namespace, audience=audience, title=title,
                source_uri=f"seed://{filename}", markdown_text=text,
            )
            print(f"{filename}: {count} chunks ({namespace}, audience={audience})")
            total_chunks += count

        for filename, namespace, audience, title, converter in YAML_SOURCES:
            path = SEED_DIR / filename
            entries = yaml.safe_load(path.read_text(encoding="utf-8"))
            chunks = converter(entries)
            count = await ingest_chunks(
                session, namespace=namespace, audience=audience, title=title,
                source_uri=f"seed://{filename}", source_type="yaml", chunks=chunks,
            )
            print(f"{filename}: {count} chunks ({namespace}, audience={audience})")
            total_chunks += count

    print(f"total: {total_chunks} chunks")


if __name__ == "__main__":
    asyncio.run(seed())
