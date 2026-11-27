# Предложения к контракту API от сессии «Веб»

Контракт (`docs/api.md`) не менялся. Веб и его моки (`services/web/src/mocks/handlers.ts`) подогнаны под фактический API
из `docs/contract-changes/backend.md` (ветка бэкенда): `Run.message`, `201` на загрузках, `415/413/400` с `code`,
`/providers/{p}/models` → `200 {models, error?}`, `/providers/{p}/test` → `200 {ok:false, error}`, SSE `retry` и
`: keepalive`, `event: error` в чате, `KnowledgeItem.error`, `/health` со `status: degraded`, `/usage` с `date` и `runs`,
`422` с массивом `errors`, `501 render_unavailable` у выгрузок, необязательные `provider`/`model` в `POST /runs`,
`RunShort` без `provider`/`model`, числовой `AuditEntry.id`. Проверяется тестом `src/api/backend-compat.test.ts`.

## Ожидается от бэкенда (передано, веб уже рассчитывает)

1. **`Run.summary` / `Document.last_run.summary`** — `Report.summary` + `ready_for_development`
   (без поля просто не показывается колонка «Итог»).
2. **`GET /health` → `limits.max_upload_mb`** — лимит в зоне загрузки и проверка размера на клиенте (иначе 25 МБ).
3. **`DELETE /knowledge/{id}` для `builtin` → `409`** — в UI кнопка и так выключена.
4. **`Content-Disposition` с `filename*=UTF-8''…`** — веб берёт имя из `filename*`, затем из `filename`.

## nginx веба
- Все `/api/*` (включая `GET /api/runs/{id}/events` и `POST /api/runs/{id}/chat`) — `proxy_buffering off`,
  `proxy_cache off`, `proxy_read_timeout 1h`; `client_max_body_size 50m`.
- `/metrics`, `/livez`, `/api/metrics` — `404`, наружу не проксируются.
