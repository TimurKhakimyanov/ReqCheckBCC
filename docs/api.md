# HTTP API (контракт между `web` и `api`)

Базовый путь `/api`. JSON, UTF-8. Авторизация — httpOnly cookie `session` (JWT, подпись `APP_SECRET_KEY`),
выдаётся при логине. Все методы, кроме `/auth/login` и `/health`, требуют сессии; иначе `401`.
Ошибки: `{"detail": "текст", "code": "machine_code"}`. Даты — ISO 8601 UTC. Идентификаторы — UUID-строки.
Модели `Report`, `ProgressEvent`, `Finding` и т. д. — из `packages/contracts` (JSON Schema:
`packages/contracts/req_contracts/fixtures/report.schema.json`, пример — `sample_report.json`).
FastAPI публикует полный OpenAPI на `/api/openapi.json` — он первичен, этот файл — согласованный черновик.

## Аутентификация
| Метод | Путь | Тело / ответ |
| :--- | :--- | :--- |
| POST | `/auth/login` | `{username, password}` → `200 {user}` + cookie; `401` |
| POST | `/auth/logout` | → `204` |
| GET | `/auth/me` | → `{id, username, role: "admin", locale}` |
| PATCH | `/auth/me` | `{locale?, password?: {current, new}}` → `{user}` |

Пользователь один (админ), создаётся при старте из `ADMIN_USERNAME` / `ADMIN_PASSWORD`.

## Провайдеры LLM (кабинет)
| Метод | Путь | Тело / ответ |
| :--- | :--- | :--- |
| GET | `/providers` | → `[{provider, enabled, has_key, key_hint: "…a1b2", base_url, default_model, updated_at}]` для `gemini, openai, anthropic, openai_compatible` |
| PUT | `/providers/{provider}` | `{api_key?, base_url?, enabled?, default_model?}` → объект провайдера. `api_key: ""` — удалить ключ |
| POST | `/providers/{provider}/test` | → `{ok, latency_ms, error?}` (короткий запрос к модели) |
| GET | `/providers/{provider}/models` | → `{models: [string]}` |

Ключ никогда не возвращается целиком.

## Документы
| Метод | Путь | Тело / ответ |
| :--- | :--- | :--- |
| POST | `/documents` | multipart `file` (pdf, docx, md, txt; ≤ `MAX_UPLOAD_MB`) → `Document` |
| GET | `/documents?limit&offset&q` | → `{items: [Document], total}` |
| GET | `/documents/{id}` | → `Document` |
| GET | `/documents/{id}/file` | исходный файл |
| DELETE | `/documents/{id}` | → `204` (вместе с прогонами) |

`Document = {id, name, format, size_bytes, sha256, created_at, runs_count, last_run?: RunShort}`

## Прогоны
| Метод | Путь | Тело / ответ |
| :--- | :--- | :--- |
| POST | `/runs` | `{document_id, provider, model, options?: ValidationOptions}` → `Run` (`202`) |
| GET | `/runs?document_id&status&limit&offset` | → `{items: [Run], total}` |
| GET | `/runs/{id}` | → `Run` |
| POST | `/runs/{id}/cancel` | → `Run` |
| DELETE | `/runs/{id}` | → `204` |
| GET | `/runs/{id}/events` | **SSE**: `event: progress` + `data: ProgressEvent`; последнее событие со стадией `done`/`failed`/`cancelled`, затем поток закрывается. При подключении сначала отдаётся текущее состояние |
| GET | `/runs/{id}/report` | → `Report` (`404`, пока не готов) |
| GET | `/runs/{id}/report.{md,docx,pdf,json}` | файл отчёта (`Content-Disposition: attachment`) |
| GET | `/runs/{id}/findings` | → `[{finding: Finding, review: FindingReview}]` |
| PATCH | `/runs/{id}/findings/{finding_id}` | `{status: open|accepted|false_positive|fixed, comment?}` → `FindingReview` |

`Run = {id, document_id, document_name, status: RunStage, stage, progress, provider, model, options,
created_at, started_at?, finished_at?, error?, usage?: Usage, summary?: Summary}`

## Чат по отчёту
| Метод | Путь | Тело / ответ |
| :--- | :--- | :--- |
| GET | `/runs/{id}/chat` | → `[ChatMessage]` |
| POST | `/runs/{id}/chat` | `{message, provider?, model?}` → **SSE**: `event: token` (`data: {"text": "..."}`), в конце `event: done` (`data: ChatMessage`) |
| DELETE | `/runs/{id}/chat` | → `204` |

`ChatMessage = {id, role: user|assistant, content, created_at}`

## Поиск и база знаний
| Метод | Путь | Тело / ответ |
| :--- | :--- | :--- |
| GET | `/search?q&kind=requirement|finding&limit` | → `[{score, kind, text, run_id, document_name, requirement_id?, finding_id?}]` (семантический, Qdrant) |
| GET | `/knowledge` | → `[KnowledgeItem]` |
| POST | `/knowledge` | multipart `file` или `{title, text}` → `KnowledgeItem` (нарезка и индексация в фоне) |
| DELETE | `/knowledge/{id}` | → `204` |

`KnowledgeItem = {id, title, source: builtin|upload|manual, chunks, status: indexing|ready|failed, created_at}`.
Пересказ критериев 29148/830 загружается как `builtin` при первом старте.

## Служебное
| Метод | Путь | Ответ |
| :--- | :--- | :--- |
| GET | `/health` | `{status, version, checks: {postgres, redis, qdrant, s3, embedder}}` |
| GET | `/usage?from&to` | `{totals: Usage, by_provider: [...], by_day: [...]}` |
| GET | `/audit?limit&offset` | `{items: [{id, ts, actor, action, target, details}], total}` |
| GET | `/metrics` | Prometheus (только во внутренней сети, через web не проксируется) |
