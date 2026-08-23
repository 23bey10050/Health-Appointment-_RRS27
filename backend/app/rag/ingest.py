"""Ingestion -- chunk, embed, store. IMPLEMENTATION.md section 8.2.

Re-ingesting a `source_uri` deletes and recreates that document's chunks rather
than keeping old + new side by side under an is_active flag: retriever.py's hybrid
query doesn't (and shouldn't need to) join against kb_documents to filter out a
superseded version, so a stale document must not still have live chunks in
kb_chunks. This is also what "reindex_clinic_kb nightly" (section 13.3) wants:
replace, not accumulate.
"""

import asyncio
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.kb import KBChunk, KBDocument
from app.rag.chunker import Chunk, chunk_markdown
from app.rag.embedder import embed_documents


async def _upsert_document(
    session: AsyncSession,
    *,
    namespace: str,
    audience: str,
    title: str,
    source_uri: str,
    source_type: str,
    patient_id: uuid.UUID | None,
) -> KBDocument:
    existing = await session.scalar(select(KBDocument).where(KBDocument.source_uri == source_uri))
    version = 1
    if existing is not None:
        version = existing.version + 1
        await session.delete(existing)  # cascades to kb_chunks
        await session.flush()

    document = KBDocument(
        namespace=namespace,
        audience=audience,
        title=title,
        source_uri=source_uri,
        source_type=source_type,
        patient_id=patient_id,
        version=version,
        is_active=True,
    )
    session.add(document)
    await session.flush()
    return document


async def _store_chunks(session: AsyncSession, document: KBDocument, chunks: list[Chunk]) -> int:
    if not chunks:
        return 0

    # Prepend heading_path before embedding *and* storage -- section 8.2: "it
    # materially improves retrieval on short queries."
    texts = [f"{c.heading_path}\n{c.content}" if c.heading_path else c.content for c in chunks]
    embeddings = await asyncio.to_thread(embed_documents, texts)

    for i, (chunk, text, embedding) in enumerate(zip(chunks, texts, embeddings)):
        session.add(
            KBChunk(
                document_id=document.id,
                namespace=document.namespace,
                audience=document.audience,
                patient_id=document.patient_id,
                chunk_index=i,
                content=text,
                heading_path=chunk.heading_path,
                embedding=embedding,
                token_count=len(text.split()),
            )
        )
    return len(chunks)


async def ingest_markdown(
    session: AsyncSession,
    *,
    namespace: str,
    audience: str,
    title: str,
    source_uri: str,
    markdown_text: str,
    patient_id: uuid.UUID | None = None,
    commit: bool = True,
) -> int:
    document = await _upsert_document(
        session, namespace=namespace, audience=audience, title=title, source_uri=source_uri,
        source_type="markdown", patient_id=patient_id,
    )
    chunks = chunk_markdown(markdown_text)
    count = await _store_chunks(session, document, chunks)
    if commit:
        await session.commit()
    return count


async def ingest_chunks(
    session: AsyncSession,
    *,
    namespace: str,
    audience: str,
    title: str,
    source_uri: str,
    source_type: str,
    chunks: list[Chunk],
    patient_id: uuid.UUID | None = None,
    commit: bool = True,
) -> int:
    """For non-markdown sources (YAML) whose caller has already produced Chunk
    objects via its own structure-aware conversion -- see rag/seed_yaml.py."""
    document = await _upsert_document(
        session, namespace=namespace, audience=audience, title=title, source_uri=source_uri,
        source_type=source_type, patient_id=patient_id,
    )
    count = await _store_chunks(session, document, chunks)
    if commit:
        await session.commit()
    return count
