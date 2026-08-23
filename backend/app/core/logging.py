import logging
import sys
import uuid
from contextvars import ContextVar

import structlog

_request_id: ContextVar[str] = ContextVar("request_id", default="-")
_session_id: ContextVar[str] = ContextVar("session_id", default="-")


def bind_request_id(value: str | None = None) -> str:
    rid = value or str(uuid.uuid4())
    _request_id.set(rid)
    return rid


def bind_session_id(value: str) -> None:
    _session_id.set(value)


def _add_correlation_ids(logger, method_name, event_dict):
    event_dict["request_id"] = _request_id.get()
    session_id = _session_id.get()
    if session_id != "-":
        event_dict["session_id"] = session_id
    return event_dict


def configure_logging(*, json_logs: bool = True, level: int = logging.INFO) -> None:
    logging.basicConfig(format="%(message)s", stream=sys.stdout, level=level)

    processors = [
        structlog.contextvars.merge_contextvars,
        _add_correlation_ids,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
    ]
    processors.append(structlog.processors.JSONRenderer() if json_logs else structlog.dev.ConsoleRenderer())

    structlog.configure(
        processors=processors,
        wrapper_class=structlog.make_filtering_bound_logger(level),
        context_class=dict,
        logger_factory=structlog.PrintLoggerFactory(),
        cache_logger_on_first_use=True,
    )
