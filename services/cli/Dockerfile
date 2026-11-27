# syntax=docker/dockerfile:1
# CLI агента ReqCheck: прогон одной командой.
#   docker compose -p reqcheck-core --profile cli run --rm cli /data/requirements.pdf /data/report.md
# Контекст сборки — корень репозитория.
FROM python:3.12-slim AS runtime
COPY --from=ghcr.io/astral-sh/uv:0.8.17 /uv /bin/uv
ENV UV_SYSTEM_PYTHON=1 UV_LINK_MODE=copy PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY packages/contracts packages/contracts
COPY packages/core packages/core
RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install packages/contracts packages/core
ARG AGENT_VERSION=dev
ENV AGENT_VERSION=${AGENT_VERSION}
RUN printf '%s' "$AGENT_VERSION" > /etc/reqcheck-agent-version
WORKDIR /data
ENTRYPOINT ["python", "-m", "req_core.cli"]
CMD ["--help"]

FROM runtime AS test
RUN --mount=type=cache,target=/root/.cache/uv uv pip install "pytest>=8"
COPY samples /repo/samples
COPY packages/core/tests /repo/packages/core/tests
WORKDIR /repo/packages/core
ENTRYPOINT []
CMD ["pytest", "-q", "tests/test_cli.py"]
