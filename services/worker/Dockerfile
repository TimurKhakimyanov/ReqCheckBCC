# syntax=docker/dockerfile:1.7
# ReqCheck worker (Celery). Контекст сборки — корень репозитория.
FROM python:3.12-slim AS base
COPY --from=ghcr.io/astral-sh/uv:0.8.17 /uv /bin/uv
ENV UV_SYSTEM_PYTHON=1 UV_LINK_MODE=copy PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /repo
COPY packages/contracts packages/contracts
COPY packages/core packages/core
COPY services/api services/api
COPY services/worker services/worker
RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install ./packages/contracts ./packages/core -e ./services/api -e ./services/worker

FROM base AS runtime
ARG AGENT_VERSION=dev
ENV AGENT_VERSION=${AGENT_VERSION} WORKER_METRICS_PORT=9101
RUN useradd --system --uid 10001 --home /nonexistent app
WORKDIR /repo/services/worker
USER app
EXPOSE 9101
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=5 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:9101/metrics', timeout=2)"
CMD ["celery", "-A", "worker.celery_app:celery", "worker", "-Q", "reqcheck", "--loglevel", "INFO", \
     "--without-gossip", "--without-mingle", "-n", "worker@%h"]

FROM base AS test
ARG AGENT_VERSION=dev
ENV AGENT_VERSION=${AGENT_VERSION}
RUN --mount=type=cache,target=/root/.cache/uv uv pip install -e "./services/worker[test]"
WORKDIR /repo/services/worker
CMD ["pytest", "-q", "-p", "no:cacheprovider"]
