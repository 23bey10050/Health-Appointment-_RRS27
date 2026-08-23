"""Conditional cross-encoder rerank -- IMPLEMENTATION.md section 8.3: only run it
when the top-2 dense/sparse fusion scores are close, since a clear leader doesn't
need a second, slower pass. See retriever.py for the gap check that decides
whether to call this at all.
"""

from functools import lru_cache

from fastembed.rerank.cross_encoder import TextCrossEncoder

from app.config import get_settings

settings = get_settings()


@lru_cache
def _model() -> TextCrossEncoder:
    return TextCrossEncoder(model_name=settings.RERANKER_MODEL)


def rerank(query: str, documents: list[str]) -> list[float]:
    """Scores in the same order as `documents` (not sorted) -- caller re-sorts."""
    return list(_model().rerank(query, documents))
