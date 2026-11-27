# syntax=docker/dockerfile:1.7
# ReqCheck API (и one-shot migrate). Контекст сборки — корень репозитория.
FROM python:3.12-slim AS base
COPY --from=ghcr.io/astral-sh/uv:0.8.17 /uv /bin/uv
ENV UV_SYSTEM_PYTHON=1 UV_LINK_MODE=copy PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /repo
COPY packages/contracts packages/contracts
COPY packages/core packages/core
COPY services/api services/api
RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install ./packages/contracts ./packages/core -e ./services/api

FROM base AS runtime
ARG AGENT_VERSION=dev
ENV AGENT_VERSION=${AGENT_VERSION}
RUN useradd --system --uid 10001 --home /nonexistent app
WORKDIR /repo/services/api
USER app
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/livez', timeout=2)"
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log", \
     "--proxy-headers", "--forwarded-allow-ips", "*", "--timeout-graceful-shutdown", "10"]

FROM base AS test
ARG AGENT_VERSION=dev
ENV AGENT_VERSION=${AGENT_VERSION}
RUN --mount=type=cache,target=/root/.cache/uv uv pip install -e "./services/api[test]"
WORKDIR /repo/services/api
CMD ["pytest", "-q", "-p", "no:cacheprovider"]
