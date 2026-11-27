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

## Новое: живые модели, локальная модель, параметры ИИ (веб уже на это рассчитан, моки так отвечают)

Пока бэкенд не опубликовал точную форму, веб использует следующую. Если будет иначе — поправлю клиент и моки.

1. **`POST /providers/{p}/test`** — тело `{api_key?, base_url?}` (ещё не сохранённые поля формы; пустые — из сохранённых).
   Ответ `200 {ok, latency_ms, error?, models?: [string]}`; `models` заполняет «Модель по умолчанию».
2. **`openai_compatible`** настроен, если задан `base_url`; ключ необязателен. `has_key` может быть `false`.
   `POST /runs` без ключа у `openai_compatible`, но с адресом — допустим.
3. **`GET /settings` → `AppSettings`, `PUT /settings` (частичное тело) → `AppSettings`:**
   ```
   {default_provider: ProviderName|null, default_model: str|null,
    run_timeout_s, request_timeout_s, min_interval_s, max_attempts, batch_size, concurrency,
    embeddings: {provider: local|gemini|openai, model, has_key, key_hint},  updated_at}
   ```
   В `PUT` ключ эмбеддингов — `embeddings.api_key` (`""` — удалить), в ответе только `has_key`/`key_hint`.
   Границы (веб проверяет сам, сервер — `422` с `errors`, `loc: ["body", "<поле>"]`): `run_timeout_s` 60–14400,
   `request_timeout_s` 10–1800, `min_interval_s` 0–120, `max_attempts` 1–20, `batch_size` 1–50, `concurrency` 1–16.
   `request_timeout_s`/`min_interval_s`/`max_attempts` → `ProviderConfig`, `batch_size`/`concurrency` → `ValidationOptions`.
   `POST /runs` без `provider`/`model` берёт `default_provider`/`default_model`.
4. **Тексты ошибок провайдера** (`Run.error`, `test.error`, `event: error` чата) веб разбирает сам: код HTTP, тип
   исключения SDK и `error.message` из тела. Сырой текст можно оставлять — он показывается в «Подробностях».
