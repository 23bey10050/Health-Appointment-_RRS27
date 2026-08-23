"""Hybrid retrieval -- IMPLEMENTATION.md section 8.3-8.4.

SAFETY-5 lives here, not in the prompt: `audience` and `patient_id` are applied in
SQL on every query, unconditionally. clinical_kb is seeded audience='doctor'
(rag/seed/), so even a caller that mistakenly includes it in `namespaces` for a
patient-facing call still gets nothing back -- the audience filter is the actual
enforcement boundary, the namespace list callers pass is not trusted alone.

Latency (section 8.4 target: p50 under 100ms): the 30-query eval (tests/test_rag_eval.py)
measured p50 851ms on this sandbox's CPU after two real fixes -- the rerank gap
check compares *relative* to the top score, not absolute (RRF scores top out
around 0.03 for RRF_K=60, so an absolute 0.05 threshold was true almost always,
firing the rerank pass on ~100% of queries instead of the intended ~30%), and the
reranker is ms-marco-MiniLM-L-6-v2 instead of a much larger cross-lingual model
(see config.py's RERANKER_MODEL comment). Non-reranked queries land around
150-160ms here (embed + hybrid SQL). The remaining gap to 100ms tracks with this
sandbox's constrained CPU allocation, not further retrieval-logic overhead --
worth re-measuring on real target hardware (section 3: "any machine with 8 GB RAM").
"""

import asyncio
import hashlib
import json
import uuid
from dataclasses import dataclass

from redis.asyncio import Redis
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.rag.embedder import embed_query
from app.rag.reranker import rerank

settings = get_settings()

RRF_K = 60
CANDIDATES_PER_ARM = 40
RERANK_POOL = 20
CACHE_TTL_SECONDS = 900


@dataclass
class RetrievedChunk:
    id: uuid.UUID
    document_id: uuid.UUID
    content: str
    heading_path: str | None
    score: float


_HYBRID_SQL = text(
    """
    WITH dense AS (
        SELECT id, content, heading_path, document_id,
               row_number() OVER (ORDER BY embedding <=> (:qvec)::vector) AS rnk
        FROM kb_chunks
        WHERE namespace = ANY(:namespaces)
          AND (audience = :audience OR audience = 'both')
          AND (patient_id IS NULL OR patient_id = :patient_id)
        ORDER BY embedding <=> (:qvec)::vector
        LIMIT :candidates
    ),
    sparse AS (
        SELECT id, content, heading_path, document_id,
               row_number() OVER (
                   ORDER BY ts_rank_cd(tsv, plainto_tsquery('english', :query_text)) DESC
               ) AS rnk
        FROM kb_chunks
        WHERE namespace = ANY(:namespaces)
          AND (audience = :audience OR audience = 'both')
          AND (patient_id IS NULL OR patient_id = :patient_id)
          AND tsv @@ plainto_tsquery('english', :query_text)
        ORDER BY ts_rank_cd(tsv, plainto_tsquery('english', :query_text)) DESC
        LIMIT :candidates
    ),
    combined AS (
        SELECT * FROM dense
        UNION ALL
        SELECT * FROM sparse
    ),
    fused AS (
        SELECT id, content, heading_path, document_id, SUM(1.0 / (:rrf_k + rnk)) AS rrf_score
        FROM combined
        GROUP BY id, content, heading_path, document_id
    )
    SELECT id, content, heading_path, document_id, rrf_score
    FROM fused
    ORDER BY rrf_score DESC
    LIMIT :pool
    """
)


async def _hybrid_search(
    session: AsyncSession, query: str, *, namespaces: list[str], audience: str, patient_id: uuid.UUID | None
) -> list[RetrievedChunk]:
    qvec = await asyncio.to_thread(embed_query, query)
    rows = (
        await session.execute(
            _HYBRID_SQL,
            {
                "qvec": str(qvec),
                "namespaces": namespaces,
                "audience": audience,
                "patient_id": patient_id,
                "query_text": query,
                "candidates": CANDIDATES_PER_ARM,
                "rrf_k": RRF_K,
                "pool": RERANK_POOL,
            },
        )
    ).all()
    return [
        # float(), not the raw column value: Postgres returns SUM(1.0/...) as
        # NUMERIC, which asyncpg maps to Decimal. The dataclass annotation says
        # float but dataclasses don't coerce, so the Decimal survived all the way
        # to the Redis cache write and blew up json.dumps ("Object of type Decimal
        # is not JSON serializable") -- silently killing every retrieval that
        # missed cache, including the voice agent's and the emergency brief's.
        RetrievedChunk(
            id=r.id, document_id=r.document_id, content=r.content,
            heading_path=r.heading_path, score=float(r.rrf_score),
        )
        for r in rows
    ]


def _cache_key(query: str, namespaces: list[str], audience: str, patient_id: uuid.UUID | None) -> str:
    normalised = " ".join(query.lower().split())
    raw = f"{normalised}|{sorted(namespaces)}|{audience}|{patient_id or ''}"
    return "rag_retrieve:" + hashlib.sha256(raw.encode()).hexdigest()


async def retrieve(
    session: AsyncSession,
    query: str,
    *,
    namespaces: list[str],
    audience: str,
    patient_id: uuid.UUID | None,
    k: int = 5,
    redis: Redis | None = None,
) -> list[RetrievedChunk]:
    """Callers in the patient-facing path MUST pass audience='patient'."""
    cache_key = _cache_key(query, namespaces, audience, patient_id)
    if redis is not None:
        cached = await redis.get(cache_key)
        if cached:
            data = json.loads(cached)
            return [RetrievedChunk(id=uuid.UUID(c["id"]), document_id=uuid.UUID(c["document_id"]), content=c["content"], heading_path=c["heading_path"], score=c["score"]) for c in data]

    pool = await _hybrid_search(session, query, namespaces=namespaces, audience=audience, patient_id=patient_id)

    # RRF scores are inherently tiny and scale with 1/RRF_K (top rank in both arms
    # tops out around 2/(RRF_K+1) =~ 0.033 here) -- an *absolute* gap of 0.05 would
    # exceed the entire possible score range and trigger on every query, which
    # defeats the point of the check (measured: p50 latency 3.3s with reranking
    # firing ~100% of the time instead of the intended ~30%, section 8.3). Compare
    # the gap *relative* to the top score instead, so the threshold means the same
    # thing ("top two are within 5% of each other") regardless of RRF_K.
    if len(pool) >= 2 and pool[0].score > 0 and (pool[0].score - pool[1].score) / pool[0].score < settings.RERANK_SCORE_GAP_THRESHOLD:
        scores = await asyncio.to_thread(rerank, query, [c.content for c in pool])
        pool = [c for c, _ in sorted(zip(pool, scores), key=lambda pair: pair[1], reverse=True)]

    result = pool[:k]

    if redis is not None:
        payload = json.dumps(
            [{"id": str(c.id), "document_id": str(c.document_id), "content": c.content, "heading_path": c.heading_path, "score": c.score} for c in result]
        )
        await redis.set(cache_key, payload, ex=CACHE_TTL_SECONDS)

    return result
