# Уточнения контракта от сессии «Бэкенд»

Реализовано по [docs/api.md](../api.md); первичен OpenAPI `/api/openapi.json` (Swagger UI: `/api/docs`).
Ниже — где реализация уточняет или расширяет черновик. Обратно совместимо: только новые поля и необязательные параметры.

## HTTP API (для сессии «Веб»)

| Где | Что |
| :--- | :--- |
| `Run` | `status` и `stage` — оба `RunStage` и всегда совпадают (текущая стадия). Добавлено поле `message` (текст последнего события; для `failed` — то же, что `error`). |
| `POST /runs` | `provider` и `model` необязательны: по умолчанию — провайдер из `LLM_PROVIDER` (если у него есть ключ, иначе первый с ключом) и его `default_model`. `400 provider_not_configured`, если ключа нет. |
| `POST /documents`, `POST /knowledge` | Ответ `201`. Ошибки: `415 unsupported_format`, `413 file_too_large`, `400 empty_file`. |
| `GET /providers/{p}/models` | Всегда `200 {models, error?}`: если провайдер недоступен или ядро не умеет `list_models`, возвращается список-подсказка и текст `error`. |
| `POST /providers/{p}/test` | Ошибка провайдера — `200 {ok: false, latency_ms, error}`. |
| `FindingReview` | `{finding_id, status, comment?, updated_at?}`; без записи — `status: "open"`. |
| `POST /runs/{id}/chat` | Кроме `token` и `done` бывает `event: error` с `data: {detail, code}` — после него поток закрывается. Отчёт должен быть готов, иначе `404 report_not_ready`. |
| SSE `/runs/{id}/events` | Перед первым событием — `retry: 3000`; каждые ~15 с комментарий `: keepalive`. |
| `KnowledgeItem` | Добавлено `error?` (для `status: failed`). `POST /knowledge` принимает `multipart/form-data` (`file`, необязательный `title`) или JSON `{title, text}`. |
| `GET /health` | Всегда `200`; `status: degraded`, если какая-то проверка не `ok` (в `checks` — текст ошибки). |
| `GET /usage` | `from`/`to` — даты `YYYY-MM-DD` (UTC, включительно; по умолчанию последние 30 дней). Строки: `{runs, llm_calls, prompt_tokens, completion_tokens, cost_usd, duration_s}`; `by_provider` добавляет `provider, model`, `by_day` — `date`. Учитываются прогоны `done` и `failed`. |
| `422` | Помимо `detail` и `code: validation_error` есть массив `errors` (как в FastAPI). |
| `GET /runs/{id}/report.{fmt}` | Если выгрузки нет в S3 (ядро не смогло отрисовать при прогоне), рисуется по запросу; `501 render_unavailable`, если ядро не поддерживает формат. |

## Для сессии «Веб» (nginx)
- `/api/runs/*/events` и `POST /api/runs/*/chat` — SSE: `proxy_buffering off; proxy_cache off; proxy_read_timeout 1h;`
  (API также шлёт `X-Accel-Buffering: no`).
- `client_max_body_size` не меньше `MAX_UPLOAD_MB` (по умолчанию 25m).
- `/metrics` и `/livez` живут в корне (не под `/api`) — через веб их не проксировать.

## Для сессии «Инфраструктура» (Prometheus)
Цели: `api:8000/metrics`, `worker:9101/metrics`, `embedder:8001/metrics`. Основные метрики:
`reqcheck_http_requests_total`, `reqcheck_http_request_duration_seconds`, `reqcheck_worker_runs_total{status}`,
`reqcheck_worker_run_duration_seconds`, `reqcheck_worker_runs_in_progress`, `reqcheck_llm_tokens_total`,
`reqcheck_llm_cost_usd_total`, `reqcheck_findings_total{severity}`, `reqcheck_embedder_texts_total`.
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
- `ProviderConfig.base_url` для `openai_compatible` по умолчанию — `OPENAI_COMPATIBLE_BASE_URL`.
