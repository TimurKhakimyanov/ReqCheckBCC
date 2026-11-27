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

## Живые модели, локальная модель, параметры ИИ

Сверено с веткой бэкенда (5eb3f04): веб и моки следуют ей.
1. `POST /providers/{p}/test` — тело `{api_key?, base_url?}` (несохранённые поля формы), ответ `{ok, latency_ms, error?, models}`.
2. `openai_compatible` настроен по `base_url`, ключ необязателен.
3. `GET/PUT /settings` — плоские поля `AppSettings` бэкенда (`default_provider`, `default_model`, `run_timeout_s`,
   `min_interval_s`, `max_attempts`, `batch_size`, `concurrency`, `embeddings_provider`, `embeddings_model`,
   `embeddings_dim`, `max_upload_mb`, `session_ttl_hours`, `embeddings_has_key`, `embeddings_key_hint`);
   ключ — `embeddings_api_key` в `PUT`. Таймаута одного запроса в настройках нет — веб его не показывает.
4. Тексты ошибок провайдера веб разбирает сам (код HTTP, тип исключения, `error.message`); сырой текст — в «Подробностях».

## Расширенные параметры провайдера

`extra_body`, `extra_body_set_review`, `max_output_tokens` — как в ветке бэкенда (51ec800): в `ProviderOut`, `PUT /providers/{p}`
(`null` — сбросить) и `extra_body` в теле `POST /providers/{p}/test`. Веб проверяет на клиенте, что JSON — объект,
а `max_output_tokens` — целое 1…1 000 000.

**Ожидается: `timeout_s`** (таймаут одного запроса к модели, с) — в `ProviderOut`, `PUT /providers/{p}` и теле
`POST /providers/{p}/test`; `null` — значение по умолчанию 180. Веб проверяет целое 10…3600; пресет vLLM ставит 900.
Проверка подключения отправляет несохранённые `extra_body` и `timeout_s` из формы.
