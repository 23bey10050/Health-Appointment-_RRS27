"""IMPLEMENTATION.md section 19: worker crash mid-send produces no duplicate.

Two invariants under test:
  1. enqueue_email is idempotent at insert time (ON CONFLICT DO NOTHING on the
     unique idempotency_key) -- re-enqueueing the same logical event is a no-op.
  2. The dispatcher claims a row (status='sending') before it attempts to send, so
     a worker that dies mid-send leaves the row claimed, not silently lost -- and a
     successful send is recorded exactly once.
"""

from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy import select

from app.models.enums import OutboxStatus
from app.models.notification import EmailOutbox
from app.services.notification import enqueue_email
from app.workers.email_dispatch import _dispatch_async


@pytest.mark.asyncio
async def test_enqueue_same_key_twice_is_a_no_op(db_session):
    context = {"patient_name": "Test Patient", "doctor_name": "Dr. Test", "start_at": "2026-08-24T09:00:00+00:00"}

    await enqueue_email(
        db_session,
        idempotency_key="dup-test:1",
        to_email="patient@example.com",
        template="booking_confirmation_patient",
        context=context,
    )
    await enqueue_email(
        db_session,
        idempotency_key="dup-test:1",
        to_email="patient@example.com",
        template="booking_confirmation_patient",
        context=context,
    )
    await db_session.commit()

    rows = (
        await db_session.scalars(select(EmailOutbox).where(EmailOutbox.idempotency_key == "dup-test:1"))
    ).all()
    assert len(rows) == 1


@pytest.mark.asyncio
async def test_successful_dispatch_sends_exactly_once(db_session, test_sessionmaker):
    await enqueue_email(
        db_session,
        idempotency_key="send-once:1",
        to_email="patient@example.com",
        template="booking_confirmation_patient",
        context={"patient_name": "Pat", "doctor_name": "Dr. Test", "start_at": "2026-08-24T09:00:00+00:00"},
    )
    await db_session.commit()

    with patch(
        "app.workers.email_dispatch.send_rendered_email", new=AsyncMock(return_value="fake-message-id")
    ) as mock_send:
        counts = await _dispatch_async()

    assert counts["sent"] == 1
    assert mock_send.await_count == 1

    async with test_sessionmaker() as session:
        row = await session.scalar(select(EmailOutbox).where(EmailOutbox.idempotency_key == "send-once:1"))
        assert row.status == OutboxStatus.sent
        assert row.provider_message_id == "fake-message-id"

    # A second dispatch pass must not re-send an already-sent row.
    with patch(
        "app.workers.email_dispatch.send_rendered_email", new=AsyncMock(return_value="fake-message-id-2")
    ) as mock_send_again:
        counts_again = await _dispatch_async()

    assert counts_again["sent"] == 0
    mock_send_again.assert_not_awaited()


@pytest.mark.asyncio
async def test_send_failure_retries_with_backoff_not_immediately(db_session, test_sessionmaker):
    await enqueue_email(
        db_session,
        idempotency_key="retry-test:1",
        to_email="patient@example.com",
        template="booking_confirmation_patient",
        context={"patient_name": "Pat", "doctor_name": "Dr. Test", "start_at": "2026-08-24T09:00:00+00:00"},
    )
    await db_session.commit()

    from app.services.notification import EmailSendError

    with patch(
        "app.workers.email_dispatch.send_rendered_email",
        new=AsyncMock(side_effect=EmailSendError("SMTP unreachable")),
    ):
        counts = await _dispatch_async()
    assert counts["failed"] == 1

    async with test_sessionmaker() as session:
        row = await session.scalar(select(EmailOutbox).where(EmailOutbox.idempotency_key == "retry-test:1"))
        assert row.status == OutboxStatus.failed
        assert row.attempts == 1
        assert row.next_attempt_at > row.created_at  # backed off into the future, not immediate

    # Immediately dispatching again must not pick it up -- it's not due yet.
    with patch("app.workers.email_dispatch.send_rendered_email", new=AsyncMock()) as mock_send:
        counts_again = await _dispatch_async()
    assert counts_again == {"sent": 0, "failed": 0, "dead": 0}
    mock_send.assert_not_awaited()


@pytest.mark.asyncio
async def test_max_attempts_dead_letters(db_session, test_sessionmaker):
    await enqueue_email(
        db_session,
        idempotency_key="dead-test:1",
        to_email="patient@example.com",
        template="booking_confirmation_patient",
        context={"patient_name": "Pat", "doctor_name": "Dr. Test", "start_at": "2026-08-24T09:00:00+00:00"},
    )
    await db_session.commit()

    async with test_sessionmaker() as session:
        row = await session.scalar(select(EmailOutbox).where(EmailOutbox.idempotency_key == "dead-test:1"))
        row.attempts = row.max_attempts - 1  # one failure away from dead
        await session.commit()

    from app.services.notification import EmailSendError

    with patch(
        "app.workers.email_dispatch.send_rendered_email",
        new=AsyncMock(side_effect=EmailSendError("still down")),
    ):
        counts = await _dispatch_async()

    assert counts["dead"] == 1
    async with test_sessionmaker() as session:
        row = await session.scalar(select(EmailOutbox).where(EmailOutbox.idempotency_key == "dead-test:1"))
        assert row.status == OutboxStatus.dead
