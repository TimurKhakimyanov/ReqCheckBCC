# Контейнер только для тестов контрактов. Контекст сборки — корень репозитория.
FROM python:3.12-slim AS test
COPY --from=ghcr.io/astral-sh/uv:0.8.17 /uv /bin/uv
ENV UV_SYSTEM_PYTHON=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /repo
COPY packages/contracts packages/contracts
COPY samples samples
RUN uv pip install -e "packages/contracts[test]"
WORKDIR /repo/packages/contracts
CMD ["pytest", "-q"]
