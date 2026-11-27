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
| GET | `/providers` | → `[{provider, enabled, has_key, key_hint: "…a1b2", base_url, default_model, extra_body, extra_body_set_review, max_output_tokens, timeout_s, updated_at}]` для `gemini, openai, anthropic, openai_compatible` |
| PUT | `/providers/{provider}` | `{api_key?, base_url?, enabled?, default_model?, extra_body?, extra_body_set_review?, max_output_tokens?, timeout_s?}` → объект провайдера. `api_key: ""` — удалить ключ; `null` в `extra_body*`/`max_output_tokens`/`timeout_s` — сбросить |
| POST | `/providers/{provider}/test` | необязательное тело `{api_key?, base_url?, extra_body?}` — несохранённые значения из формы поверх сохранённых (не записываются) → `{ok, latency_ms, error?, models: [string], model, default_model_valid, warning?}`: живой список моделей и короткий запрос к модели — к модели по умолчанию, если она есть в списке, иначе к подходящей из списка (`model` — на какой проверено). `default_model_valid: false` и `warning` — модель по умолчанию устарела у провайдера (ключ при этом рабочий, `ok: true`); `null` — модель не задана или список не получен |
| GET | `/providers/{provider}/models` | → `{models: [string], error?, default_model, default_model_valid, warning?}` — живой список через ядро с сохранёнными ключом и адресом; при ошибке — подсказки и текст `error` (`default_model_valid: null`) |

Ключ никогда не возвращается целиком. При старте api проверяет сохранённые модели по умолчанию (в карточке провайдера и в `/settings`)
и обнуляет те, которых нет в живом списке провайдера; если список получить не удалось, ничего не меняется (в аудите —
`default_model_reset`). `openai_compatible` (vLLM, Ollama, LM Studio) считается настроенным, если задан
`base_url` (например `http://vllm.example.local:8000/v1`); ключ необязателен. Адреса по умолчанию нет.

Доп. параметры запроса к модели (передаются ядру в `ProviderConfig`, в том числе в `test`):
- `extra_body` — JSON-объект, добавляемый в тело запроса OpenAI-совместимого сервера. Например, для vLLM-модели с
  рассуждениями: `{"chat_template_kwargs": {"enable_thinking": false}}` — без него проверка ключа и прогон идут минутами.
- `extra_body_set_review` — то же для проверки набора требований (поиск противоречий), например
  `{"chat_template_kwargs": {"enable_thinking": true}}`; `null` — как `extra_body`.
- `max_output_tokens` — лимит ответа; `null` — ядро выбирает с запасом.
- `timeout_s` — таймаут одного запроса к модели, с (10…3600; `null` — 180 с). Модели с рассуждениями на проверке набора
  отвечают 3–5 минут — ставьте 900. Используется и в `test`. Общий таймаут прогона (`run_timeout_s` в `/settings`)
  воркер автоматически увеличивает до `1.2 × timeout_s`, если он короче.

`extra_body*` принимаются как объект или строка с JSON-объектом; иначе `422`. Параллельность запросов — глобальная
настройка `concurrency` в `/settings`.

## Настройки приложения (кабинет)
Всё про ИИ задаётся здесь, а не в `.env`: api и worker не читают из окружения ключи, модели и параметры LLM/эмбеддингов.

| Метод | Путь | Тело / ответ |
| :--- | :--- | :--- |
| GET | `/settings` | → `Settings` |
| PUT | `/settings` | частичный `Settings` (только меняемые поля) + `embeddings_api_key?` (`""` — удалить) → `Settings` |

`Settings = {default_provider, default_model?, run_timeout_s, min_interval_s, max_attempts, batch_size, concurrency,
embeddings_provider: local|gemini|openai, embeddings_model?, embeddings_dim?, embeddings_has_key, embeddings_key_hint?,
max_upload_mb, session_ttl_hours, updated_at}`.

| Поле | По умолчанию | Смысл |
| :--- | :--- | :--- |
| `default_provider`, `default_model` | `gemini`, — | Провайдер и модель для `POST /runs` без явных `provider`/`model` (если провайдер не настроен — первый настроенный) |
| `run_timeout_s` | 1800 (60…21600) | Общий таймаут прогона |
| `min_interval_s`, `max_attempts` | 0, 6 | Пауза между вызовами LLM и число попыток (→ `ProviderConfig`) |
| `batch_size`, `concurrency` | 6, 1 | Требований в запросе и параллельных запросов (→ `ValidationOptions`, если клиент не задал их в `options`) |
| `embeddings_provider`, `embeddings_model`, `embeddings_dim` | `local`, —, — | Эмбеддинги для поиска и базы знаний. `local` — модель внутри `embedder`; `gemini`/`openai` — по ключу из настроек. Смена — коллекции Qdrant пересоздаются, всё индексируется заново в фоне |
| `max_upload_mb` | 25 | Лимит загрузки (отдаётся и в `GET /health` → `limits`) |
| `session_ttl_hours` | 12 | Срок сессии после входа |

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
