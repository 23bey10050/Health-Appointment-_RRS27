"""The scheduled-job HTTP triggers replace Celery beat on hosting tiers with no
background worker, so their authorization is the only thing standing between an
anonymous caller and every background job in the system."""

import pytest
from fastapi import HTTPException

from app.api.v1 import jobs


def _set_secret(monkeypatch, value: str) -> None:
    # jobs.py binds `settings` at import time, so patch that object directly
    # rather than the environment.
    monkeypatch.setattr(jobs.settings, "JOBS_SECRET", value, raising=False)


def test_unconfigured_secret_fails_closed(monkeypatch):
    """An unset secret must not mean 'no auth required'."""
    _set_secret(monkeypatch, "")
    with pytest.raises(HTTPException) as exc:
        jobs._authorize("anything")
    assert exc.value.status_code == 503


def test_missing_header_rejected(monkeypatch):
    _set_secret(monkeypatch, "s3cret")
    with pytest.raises(HTTPException) as exc:
        jobs._authorize(None)
    assert exc.value.status_code == 401


def test_wrong_secret_rejected(monkeypatch):
    _set_secret(monkeypatch, "s3cret")
    with pytest.raises(HTTPException) as exc:
        jobs._authorize("wrong")
    assert exc.value.status_code == 401


def test_correct_secret_accepted(monkeypatch):
    _set_secret(monkeypatch, "s3cret")
    jobs._authorize("s3cret")  # must not raise


@pytest.mark.asyncio
async def test_tick_isolates_failures(monkeypatch):
    """One failing job must not prevent the others from running -- otherwise a
    single bad job silently stops email dispatch for everyone."""
    _set_secret(monkeypatch, "s3cret")

    async def boom():
        raise RuntimeError("db down")

    async def fine():
        return 7

    monkeypatch.setattr(jobs, "_expire_holds_async", boom)
    monkeypatch.setattr(jobs, "_dispatch_async", fine)
    monkeypatch.setattr(jobs, "_generate_pre_visit_summaries_async", fine)

    result = await jobs.tick(x_jobs_secret="s3cret")
    assert result["expire_holds"] == {"error": "db down"}
    assert result["dispatch_emails"] == 7
    assert result["generate_pre_visit_summaries"] == 7
