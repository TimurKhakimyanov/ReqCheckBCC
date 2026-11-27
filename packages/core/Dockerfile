# ЗАГЛУШКА каркаса: заменяется сессией-владельцем (см. docs/architecture.md).
# Контекст сборки — корень репозитория. Обязательные стадии: runtime и test.
FROM python:3.12-slim AS runtime
ARG AGENT_VERSION=dev
ENV AGENT_VERSION=${AGENT_VERSION}
CMD ["python", "-c", "print('placeholder')"]

FROM runtime AS test
CMD ["python", "-c", "print('no tests yet')"]
