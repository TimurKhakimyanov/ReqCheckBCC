# syntax=docker/dockerfile:1
# Ядро агента (req_core): стадия test — юнит-тесты на FakeLLM, без сети.
# Контекст сборки — корень репозитория.
FROM python:3.12-slim AS base
COPY --from=ghcr.io/astral-sh/uv:0.8.17 /uv /bin/uv
ENV UV_SYSTEM_PYTHON=1 UV_LINK_MODE=copy PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY packages/contracts packages/contracts
COPY packages/core packages/core
RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install -e packages/contracts -e "packages/core[test]"
ARG AGENT_VERSION=dev
RUN printf '%s' "$AGENT_VERSION" > /etc/reqcheck-agent-version

FROM base AS test
COPY samples samples
WORKDIR /repo/packages/core
CMD ["pytest", "-q"]
