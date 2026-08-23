"""Structure-aware YAML -> Chunk conversion. Each seed YAML file has its own shape
(section 8.5), so unlike markdown there's no single generic chunker -- one small
function per file, each producing one Chunk per entry (an entry is naturally
chunk-sized and self-contained; splitting it further would break the association
between a symptom group and its keywords, or a category and its explanation).
"""

from app.rag.chunker import Chunk


def specialisation_routing_chunks(entries: list[dict]) -> list[Chunk]:
    chunks = []
    for e in entries:
        keywords = ", ".join(e.get("keywords", []))
        text = f"Symptom group: {e['symptom_group']}. Related terms: {keywords}. Routes to: {e['specialisation']}."
        if e.get("notes"):
            text += f" {e['notes'].strip()}"
        chunks.append(Chunk(content=text, heading_path=f"Specialisation routing > {e['specialisation']}"))
    return chunks


def red_flag_definitions_chunks(entries: list[dict]) -> list[Chunk]:
    chunks = []
    for e in entries:
        text = f"{e['category'].replace('_', ' ').title()}: {e['plain_explanation'].strip()}"
        chunks.append(Chunk(content=text, heading_path=f"Emergency categories > {e['category']}"))
    return chunks


def clarifying_questions_chunks(entries: list[dict]) -> list[Chunk]:
    chunks = []
    for e in entries:
        questions = " ".join(f"- {q}" for q in e.get("questions", []))
        text = f"Standard clarifying questions for '{e['complaint']}': {questions}"
        chunks.append(Chunk(content=text, heading_path=f"Clarifying questions > {e['complaint']}"))
    return chunks
