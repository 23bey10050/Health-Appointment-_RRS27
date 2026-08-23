FROM python:3.11-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /srv

# ffmpeg was here for faster-whisper's audio decoding; both speech engines now run
# in the browser, so it's gone (~250MB). build-essential is still needed to build
# a few wheels that have no manylinux build for slim.
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        libpq-dev \
        curl \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml ./
COPY app ./app
COPY alembic.ini ./
COPY alembic ./alembic
COPY scripts ./scripts

# Production installs [rag] only. Compose overrides this with [dev,rag] so the
# test suite can run in-container; tests are NOT copied into the image, so a
# production build has no pytest/ruff/mypy and no test code.
ARG INSTALL_EXTRAS="[rag]"
RUN pip install -e ".${INSTALL_EXTRAS}"

EXPOSE 8000

# --proxy-headers is required behind a cloud load balancer: without it
# request.client.host is the balancer's IP for every request, so the IP-keyed
# rate limiter in core/rate_limit.py would throttle all users as a single client.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", \
     "--proxy-headers", "--forwarded-allow-ips", "*"]
