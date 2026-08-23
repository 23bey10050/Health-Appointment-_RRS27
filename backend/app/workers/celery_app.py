from celery import Celery
from celery.schedules import crontab

from app.config import get_settings

settings = get_settings()

celery_app = Celery(
    "clinic",
    broker=settings.REDIS_URL,
    backend=settings.REDIS_URL,
)

celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="UTC",
    enable_utc=True,
    beat_schedule={
        # Phase 1
        "expire-holds": {
            "task": "app.workers.holds.expire_holds",
            "schedule": 30.0,
        },
        # Phase 2
        "dispatch-emails": {
            "task": "app.workers.email_dispatch.dispatch_emails",
            "schedule": 15.0,
        },
        "send-medication-reminders": {
            "task": "app.workers.reminders.send_medication_reminders",
            "schedule": 300.0,
        },
        "generate-appointment-reminders": {
            "task": "app.workers.reminders.generate_appointment_reminders",
            "schedule": crontab(minute=0),
        },
        "reconcile-calendar": {
            "task": "app.workers.calendar_jobs.reconcile_calendar",
            "schedule": crontab(minute=0, hour="*/6"),
        },
        # Phase 3
        "generate-pre-visit-summaries": {
            "task": "app.workers.summary_jobs.generate_pre_visit_summaries",
            "schedule": 600.0,
        },
        # Phase 7
        "purge-expired-audio": {
            "task": "app.workers.audio_retention.purge_expired_audio",
            "schedule": crontab(minute=0, hour=3),
        },
    },
)

# Explicit imports, not autodiscover_tasks: that only scans each listed package for a
# `tasks.py` submodule, and this package deliberately uses one file per concern
# (holds.py, reminders.py, email_dispatch.py, ...) per IMPLEMENTATION.md section 5.
# Each import runs that module's @celery_app.task decorators, registering the task.
# Safe despite these modules importing `celery_app` back from here: this line only
# runs after `celery_app` above is fully constructed, so the circular import resolves.
from app.workers import (  # noqa: E402,F401
    audio_retention,
    calendar_jobs,
    email_dispatch,
    holds,
    reminders,
    summary_jobs,
)
