"""Domain exceptions and their translation to HTTP responses.

Kept deliberately small and flat: every exception here maps 1:1 to a user-facing
error the API can return without leaking internals (stack traces, SQL text, etc).
"""

from fastapi import FastAPI, Request, status
from fastapi.responses import JSONResponse
from structlog import get_logger

logger = get_logger(__name__)


class AppError(Exception):
    """Base for all domain errors. `status_code` and `code` drive the HTTP response."""

    status_code = status.HTTP_400_BAD_REQUEST
    code = "app_error"

    def __init__(self, message: str):
        self.message = message
        super().__init__(message)


class SlotUnavailableError(AppError):
    status_code = status.HTTP_409_CONFLICT
    code = "slot_unavailable"


class NotFoundError(AppError):
    status_code = status.HTTP_404_NOT_FOUND
    code = "not_found"


class ValidationAppError(AppError):
    status_code = status.HTTP_422_UNPROCESSABLE_CONTENT
    code = "validation_error"


class ConflictError(AppError):
    status_code = status.HTTP_409_CONFLICT
    code = "conflict"


class AuthError(AppError):
    status_code = status.HTTP_401_UNAUTHORIZED
    code = "auth_error"


class PermissionDeniedError(AppError):
    status_code = status.HTTP_403_FORBIDDEN
    code = "permission_denied"


def register_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def _handle_app_error(request: Request, exc: AppError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content={"code": exc.code, "message": exc.message},
        )

    @app.exception_handler(Exception)
    async def _handle_unexpected(request: Request, exc: Exception) -> JSONResponse:
        logger.exception("unhandled_exception", path=str(request.url))
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={"code": "internal_error", "message": "Something went wrong. Please try again."},
        )
