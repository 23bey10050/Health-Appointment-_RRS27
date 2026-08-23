"""bge-small-en-v1.5 via fastembed (ONNX, CPU, ~5ms/query) -- IMPLEMENTATION.md
section 8.2.

fastembed exposes query_embed()/passage_embed() as if they handle this model's
asymmetric query/passage distinction automatically, but empirically (verified
directly against fastembed 0.8.0) they return byte-identical vectors for
bge-small-en-v1.5 -- cosine similarity 1.0, no distinction applied. Section 8.2 is
explicit that skipping the query prefix "measurably degrades results", so this
module prepends it by hand rather than trusting the library to have done it.
"""

from functools import lru_cache

from fastembed import TextEmbedding

from app.config import get_settings

settings = get_settings()

QUERY_PREFIX = "Represent this sentence for searching relevant passages: "


@lru_cache
def _model() -> TextEmbedding:
    return TextEmbedding(settings.EMBEDDING_MODEL)


def embed_documents(texts: list[str]) -> list[list[float]]:
    """For chunk storage at ingestion time -- no query prefix."""
    return [vec.tolist() for vec in _model().embed(texts)]


def embed_query(text: str) -> list[float]:
    """For a retrieval query -- prefixed per the asymmetric-model requirement above."""
    return next(iter(_model().embed([QUERY_PREFIX + text]))).tolist()
