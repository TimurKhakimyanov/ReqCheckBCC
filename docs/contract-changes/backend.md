# Уточнения контракта от сессии «Бэкенд»

Реализовано по [docs/api.md](../api.md); первичен OpenAPI `/api/openapi.json` (Swagger UI: `/api/docs`).
Ниже — где реализация уточняет или расширяет черновик. Обратно совместимо: только новые поля и необязательные параметры.

## Раунд «всё про ИИ — в админке» (для сессии «Веб»)

| Где | Что |
| :--- | :--- |
| **Новое** `GET/PUT /api/settings` | Настройки приложения: провайдер и модель по умолчанию, `run_timeout_s`, `min_interval_s`, `max_attempts`, `batch_size`, `concurrency`, эмбеддинги (`embeddings_provider: local\|gemini\|openai`, `embeddings_model`, `embeddings_dim`, ключ `embeddings_api_key` → наружу только `embeddings_has_key`/`embeddings_key_hint`), `max_upload_mb`, `session_ttl_hours`. `PUT` — частичный: передавайте только изменённые поля; `null` в `default_model`/`embeddings_model`/`embeddings_dim` — сброс; `embeddings_api_key: ""` — удалить ключ. Ошибки диапазонов — `422`. Схема и диапазоны — в `docs/api.md`, раздел «Настройки приложения». |
| `POST /providers/{p}/test` | Необязательное тело `{api_key?, base_url?}` — значения из формы до сохранения. Ответ `{ok, latency_ms, error?, models: [..]}`: выпадающий список моделей можно заполнить сразу после ввода ключа/адреса. Ничего не сохраняет. |
| `GET /providers/{p}/models` | Живой список с сохранёнными данными; при ошибке — `{models: подсказки, error}`. |
| `openai_compatible` | Настроен, если задан `base_url`; ключ необязателен. Адреса по умолчанию больше нет (`base_url: null`, пока админ не задаст). В форме ключ для этого провайдера — необязательное поле. |
| `POST /runs` | Без `provider`/`model` — из `/settings` (`default_provider`, `default_model`); если провайдер не настроен — первый настроенный. `batch_size`/`concurrency` берутся из настроек, если не заданы в `options`; итоговые значения видны в `Run.options`. |
| `GET /health` → `limits.max_upload_mb` | Теперь из настроек (меняется без перезапуска). |
| Смена эмбеддингов | После `PUT /settings` с другим провайдером/моделью эмбеддингов база знаний и поиск переиндексируются в фоне; элементы базы знаний на это время в `status: indexing`, при ошибке ключа — `failed` с текстом. |

## HTTP API (для сессии «Веб»)

| Где | Что |
| :--- | :--- |
| `Run` | `status` и `stage` — оба `RunStage` и всегда совпадают (текущая стадия). Добавлено поле `message` (текст последнего события; для `failed` — то же, что `error`). |
| `Run.summary`, `Document.last_run.summary` | `Report.summary` + `ready_for_development`, `ready_for_testing` (из `Report.conclusion`); в `by_severity` всегда все три ключа. |
| `DELETE /knowledge/{id}` | Встроенный материал (`source: builtin`) — `409 builtin_protected`. |
| Выгрузки и исходный файл | `Content-Disposition: attachment; filename="<ascii>"; filename*=UTF-8''<имя>`. |
| `POST /documents`, `POST /knowledge` | Ответ `201`. Ошибки: `415 unsupported_format`, `413 file_too_large`, `400 empty_file`. |
| `FindingReview` | `{finding_id, status, comment?, updated_at?}`; без записи — `status: "open"`. |
| `POST /runs/{id}/chat` | Кроме `token` и `done` бывает `event: error` с `data: {detail, code}` — после него поток закрывается. Отчёт должен быть готов, иначе `404 report_not_ready`. |
| SSE `/runs/{id}/events` | Перед первым событием — `retry: 3000`; каждые ~15 с комментарий `: keepalive`. |
| `KnowledgeItem` | Добавлено `error?` (для `status: failed`). `POST /knowledge` принимает `multipart/form-data` (`file`, необязательный `title`) или JSON `{title, text}`. |
| `GET /health` | Всегда `200`; `status: degraded`, если какая-то проверка не `ok` (в `checks` — текст ошибки). Поле `limits: {max_upload_mb}`. |
| `GET /usage` | `from`/`to` — даты `YYYY-MM-DD` (UTC, включительно; по умолчанию последние 30 дней). Строки: `{runs, llm_calls, prompt_tokens, completion_tokens, cost_usd, duration_s}`; `by_provider` добавляет `provider, model`, `by_day` — `date`. Учитываются прогоны `done` и `failed`. | Поле дня в `by_day` — `date` (веб подстраивается).
| `422` | Помимо `detail` и `code: validation_error` есть массив `errors` (как в FastAPI). |
| `GET /runs/{id}/report.{fmt}` | Если выгрузки нет в S3 (ядро не смогло отрисовать при прогоне), рисуется по запросу; `501 render_unavailable`, если ядро не поддерживает формат. |

## Для сессии «Веб» (nginx)
- `/api/runs/*/events` и `POST /api/runs/*/chat` — SSE: `proxy_buffering off; proxy_cache off; proxy_read_timeout 1h;`
  (API также шлёт `X-Accel-Buffering: no`).
- `client_max_body_size` не меньше `MAX_UPLOAD_MB` (по умолчанию 25m).
- `/metrics` и `/livez` живут в корне (не под `/api`) — через веб их не проксировать.

## Для сессии «Инфраструктура» (Prometheus)
Цели: `api:8000/metrics`, `worker:9101/metrics`, `embedder:8001/metrics`. Имена и метки — по `docs/monitoring.md` (ветка infra):
- api: `reqcheck_http_requests_total{method,route,status}`, `reqcheck_http_request_duration_seconds{method,route}`
  (без SSE; `/metrics`, `/livez`, `/api/health` не считаются), `reqcheck_sse_connections{stream=run_events|chat}`,
  `reqcheck_llm_requests_total{provider,model,outcome}` и `reqcheck_llm_request_duration_seconds` для чата.
  Дополнительно: `reqcheck_logins_total{result}`, `reqcheck_runs_created_total{provider}`, `reqcheck_documents_uploaded_total{format}`.
- worker: `reqcheck_runs_total{status,provider}`, `reqcheck_run_duration_seconds{status,provider}`,
  `reqcheck_run_stage_duration_seconds{stage}`, `reqcheck_runs_in_progress` (livesum), `reqcheck_findings_total{severity}`,
  `reqcheck_llm_tokens_total{provider,model,type=input|output}`, `reqcheck_llm_requests_total{…,outcome="ok"}` (из `Report.usage.llm_calls`;
  `error`/`retry` и `reqcheck_llm_request_duration_seconds` по каждому вызову видны только ядру — в бэклоге),
  `reqcheck_llm_cost_usd_total`. Multiprocess-режим включается `PROMETHEUS_MULTIPROC_DIR` (каталог чистится при старте).
- embedder: `reqcheck_embedder_texts_total{kind}`, `reqcheck_embedder_request_seconds`, `reqcheck_embedder_errors_total`.
- Очередь Celery называется `celery` (db0) — `REDIS_EXPORTER_CHECK_SINGLE_KEYS=db0=celery` подходит.
- Healthcheck api — `GET /livez` (живость процесса); `/api/health` — глубокая проверка зависимостей, всегда `200`.
- api и worker ждут `qdrant` и `seaweedfs` в состоянии `service_healthy` — нужны healthcheck'и из ветки infra.
- SeaweedFS: бакет `${S3_BUCKET}` создаётся api сам. Если в `deploy/seaweedfs/s3.json` появятся identities —
  ключи должны совпадать с `S3_ACCESS_KEY`/`S3_SECRET_KEY` и иметь права Admin (создание бакета) или бакет создаётся заранее.

## Для сессии «Ядро»
- Воркер вызывает `validate_document(path, cfg, options=..., on_progress=..., document_name=...)`. Файл лежит во временном
  каталоге под исходным именем документа.
- `on_progress` может бросить исключение (отмена прогона пользователем или таймаут) — его нельзя глотать, пусть оно
  прервёт конвейер. Вызывайте `on_progress` хотя бы раз на каждое требование, чтобы отмена срабатывала быстро.
- Финальные стадии ядра (`done`/`failed`/`cancelled`) воркер не пересылает: `done` публикуется после сохранения отчёта.
  Прогресс ядра 0..1 масштабируется воркером в 0.02..0.90.
- Ошибки провайдера классифицируются по имени/тексту исключения (`AuthenticationError`, `401`, `429`, `RateLimit`,
  `timeout`, `connect`) в понятное сообщение в `runs.error`. `NotImplementedError` → «ядро ещё не реализовано».
- `render_report(report, "md"|"docx"|"pdf")` вызывается воркером; падение одного формата не валит прогон.
- API вызывает `answer_question` (чат), `get_llm(cfg).complete(system, user)` (кнопка «Проверить ключ»),
  `list_models(cfg)`, `parse_document` (загрузка PDF/DOCX в базу знаний).
- `ProviderConfig.base_url` для `openai_compatible` задаётся в админке; ключ может быть `None`. `min_interval_s` и `max_attempts` воркер берёт из `/settings` — ядру в режиме api/worker не нужно читать `LLM_MIN_INTERVAL_S`, `LLM_MAX_ATTEMPTS`, `REQCHECK_BATCH_SIZE`, `OPENAI_COMPATIBLE_*` и `*_API_KEY` из окружения (в контейнерах api/worker их больше нет).

## Для main / «Инфраструктуры» (`compose.yaml`, общий якорь `x-app-env`)
- api/worker больше не читают `DEFAULT_LLM_PROVIDER`, `DEFAULT_LLM_MODEL`, `OPENAI_COMPATIBLE_BASE_URL` — их можно убрать
  из `x-app-env` (это общий блок, бэкенд его не правит). Из моих разделов убраны `MAX_UPLOAD_MB`, `RUN_TIMEOUT_S`,
  `SESSION_TTL_HOURS`, все `*_API_KEY`, `OPENAI_COMPATIBLE_*`, `EMBEDDINGS_*`. В окружении остались `COOKIE_SECURE` (зависит
  от TLS на хосте) и `WORKER_CONCURRENCY` (размер пула воркера, нужен перезапуск).
- `EMBEDDINGS_MODEL` остаётся только аргументом сборки `embedder`: какую локальную модель вшить в образ (имя пишется в
  `/models/MODEL`). В рантайме embedder окружение не читает; внешний провайдер, модель и ключ приходят в запросе от api.
