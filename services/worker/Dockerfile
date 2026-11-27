# syntax=docker/dockerfile:1.7
# ReqCheck worker (Celery). Контекст сборки — корень репозитория.
FROM python:3.12-slim AS base
COPY --from=ghcr.io/astral-sh/uv:0.8.17 /uv /bin/uv
ENV UV_SYSTEM_PYTHON=1 UV_LINK_MODE=copy PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
# Шрифт с кириллицей для выгрузки отчёта в PDF (req_core.render_report)
RUN apt-get update && apt-get install -y --no-install-recommends fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY packages/contracts packages/contracts
COPY packages/core packages/core
COPY services/api services/api
COPY services/worker services/worker
RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install ./packages/contracts ./packages/core -e ./services/api -e ./services/worker

FROM base AS runtime
# Версия агента для паспорта отчёта — коммит из .git (если сборка идёт из клона); README.md нужен, чтобы COPY
# не падал, когда каталога .git нет (сборка из архива): тогда версия берётся из AGENT_VERSION.
COPY README.md .gi[t] /tmp/gitinfo/
RUN python -m req_core.version /tmp/gitinfo > /etc/reqcheck-git-version && rm -rf /tmp/gitinfo
ARG AGENT_VERSION=dev
ENV AGENT_VERSION=${AGENT_VERSION} WORKER_METRICS_PORT=9101
RUN useradd --system --uid 10001 --home /nonexistent app \
    && mkdir -p /cache/llm && chown -R app /cache   # кэш ответов модели (том llm-cache)
WORKDIR /repo/services/worker
USER app
EXPOSE 9101
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=5 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:9101/metrics', timeout=2)"
# Каталог multiprocess-метрик (PROMETHEUS_MULTIPROC_DIR) очищается при каждом старте — docs/monitoring.md
CMD ["sh", "-c", "if [ -n \"$PROMETHEUS_MULTIPROC_DIR\" ]; then rm -rf \"$PROMETHEUS_MULTIPROC_DIR\" && mkdir -p \"$PROMETHEUS_MULTIPROC_DIR\"; fi; exec celery -A worker.celery_app:celery worker -Q celery --loglevel INFO --without-gossip --without-mingle -n worker@%h"]

FROM base AS test
ARG AGENT_VERSION=dev
ENV AGENT_VERSION=${AGENT_VERSION}
RUN --mount=type=cache,target=/root/.cache/uv uv pip install -e "./services/worker[test]"
WORKDIR /repo/services/worker
CMD ["pytest", "-q", "-p", "no:cacheprovider"]
