"""HTTP triggers for the scheduled jobs.

Render's free tier has no Background Workers or Cron Jobs, so `celery worker` and
`celery beat` have nowhere to run. Each job is exposed here instead and driven by
a GitHub Actions cron workflow (see deploy/README). That doubles as a keep-alive:
the free tier otherwise spins down after 15 minutes and cold-starts in ~50s.

These call the same async functions the Celery tasks wrap, so each job has one
implementation. The task wrappers are left intact, so moving to a paid worker
later needs no code change -- just stop calling these endpoints.

Auth is a shared secret in `X-Jobs-Secret` compared with `secrets.compare_digest`,
not the usual JWT dependency: the caller is a cron runner, not a user with an
account.
"""

import secrets

import structlog
from fastapi import APIRouter, Header, HTTPException, status

from app.config import get_settings
from app.workers.audio_retention import _purge_expired_audio_async
from app.workers.email_dispatch import _dispatch_async
from app.workers.holds import _expire_holds_async
from app.workers.reminders import _generate_appointment_reminders_async, _send_medication_reminders_async
from app.workers.summary_jobs import _generate_pre_visit_summaries_async

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/jobs", tags=["jobs"])
settings = get_settings()


def _authorize(provided: str | None) -> None:
    expected = settings.JOBS_SECRET
    if not expected:
        # Fail closed: an unset secret must not mean "open to everyone".
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Job endpoints are not configured.")
    if not provided or not secrets.compare_digest(provided, expected):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid job secret.")


async def _run(name: str, coro):
    """Run one job, logging the outcome. Errors return 500 so the scheduler's own
    retry/alerting sees them rather than a silent success."""
    try:
        result = await coro
    except Exception as e:  # noqa: BLE001 -- surfaced to the caller, not swallowed
        logger.error("scheduled_job_failed", job=name, error=str(e), exc_info=True)
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, f"{name} failed: {e}") from e
    logger.info("scheduled_job_ran", job=name, result=result)
    return {"job": name, "result": result}


@router.post("/expire-holds")
async def expire_holds(x_jobs_secret: str | None = Header(None)):
    _authorize(x_jobs_secret)
    return await _run("expire_holds", _expire_holds_async())


@router.post("/dispatch-emails")
async def dispatch_emails(x_jobs_secret: str | None = Header(None)):
    _authorize(x_jobs_secret)
    return await _run("dispatch_emails", _dispatch_async())


@router.post("/appointment-reminders")
async def appointment_reminders(x_jobs_secret: str | None = Header(None)):
    _authorize(x_jobs_secret)
    return await _run("generate_appointment_reminders", _generate_appointment_reminders_async())


@router.post("/medication-reminders")
async def medication_reminders(x_jobs_secret: str | None = Header(None)):
    _authorize(x_jobs_secret)
    return await _run("send_medication_reminders", _send_medication_reminders_async())


@router.post("/pre-visit-summaries")
async def pre_visit_summaries(x_jobs_secret: str | None = Header(None)):
    _authorize(x_jobs_secret)
    return await _run("generate_pre_visit_summaries", _generate_pre_visit_summaries_async())


@router.post("/purge-expired-audio")
async def purge_expired_audio(x_jobs_secret: str | None = Header(None)):
    _authorize(x_jobs_secret)
    return await _run("purge_expired_audio", _purge_expired_audio_async())


@router.post("/tick")
async def tick(x_jobs_secret: str | None = Header(None)):
    """Everything that should run every few minutes, in one call.

    Lets the cron workflow hit a single URL on a short interval instead of
    juggling six schedules. The daily/hourly jobs (reminders, purge) keep their
    own endpoints. Jobs run sequentially and independently: one failing must not
    stop the rest, so failures are collected rather than raised.
    """
    _authorize(x_jobs_secret)
    results: dict[str, object] = {}
    for name, coro_factory in (
        ("expire_holds", _expire_holds_async),
        ("dispatch_emails", _dispatch_async),
        ("generate_pre_visit_summaries", _generate_pre_visit_summaries_async),
    ):
        try:
            results[name] = await coro_factory()
        except Exception as e:  # noqa: BLE001 -- see docstring
            logger.error("scheduled_job_failed", job=name, error=str(e), exc_info=True)
            results[name] = {"error": str(e)}
    logger.info("scheduled_tick_ran", results=results)
    return results
