# syntax=docker/dockerfile:1.7
# Веб-интерфейс ReqCheck. Контекст сборки — корень репозитория.
# Стадии: deps → test (tsc, eslint, vitest) | build → runtime (nginx, порт 8080).

FROM node:22-alpine AS deps
WORKDIR /repo/services/web
# Корпоративный прокси с подменой TLS: корневые сертификаты из services/web/certs/*.crt (см. certs/README.md).
COPY services/web/certs/ /tmp/certs/
RUN cat /tmp/certs/*.crt > /tmp/extra-ca.pem 2>/dev/null || true
ENV NODE_EXTRA_CA_CERTS=/tmp/extra-ca.pem \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=1
RUN corepack enable && corepack prepare pnpm@10.11.0 --activate
COPY services/web/package.json services/web/pnpm-lock.yaml ./
RUN --mount=type=cache,id=reqcheck-pnpm,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile
# Общий контракт: JSON Schema отчёта и пример отчёта (моки, тесты, генерация типов).
COPY packages/contracts/req_contracts/fixtures/report.schema.json packages/contracts/req_contracts/fixtures/sample_report.json /repo/packages/contracts/req_contracts/fixtures/
COPY samples/requirements.md /repo/samples/requirements.md
COPY services/web/ ./

FROM deps AS test
CMD ["sh", "-c", "pnpm check:types-gen && pnpm typecheck && pnpm lint && pnpm test"]

FROM deps AS build
ARG VITE_USE_MOCKS=false
ARG AGENT_VERSION=dev
ENV VITE_USE_MOCKS=${VITE_USE_MOCKS} \
    VITE_APP_VERSION=${AGENT_VERSION}
RUN pnpm build

FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
COPY services/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/services/web/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
