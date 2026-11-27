# Архитектура ReqCheck

ReqCheck — ИИ-агент статической проверки требований (ISO/IEC/IEEE 29148:2018 п. 5.2.5–5.2.6, IEEE 830 п. 4.3)
с веб-интерфейсом и самостоятельным развёртыванием в инфраструктуре заказчика (`docker compose up`).
Постановка хакатона — [docs/task.md](task.md). Пример входного документа — [samples/requirements.md](../samples/requirements.md)
(вход от организаторов, не результат).

## Сервисы

```
              хост: nginx/TLS заказчика
                         │  127.0.0.1:${WEB_PORT}
                    ┌────▼────┐
                    │   web   │  React SPA + nginx; /api/* → api:8000 (SSE без буферизации)
                    └────┬────┘
                    ┌────▼────┐        ┌──────────┐
                    │   api   │───────►│ embedder │  эмбеддинги (локальная модель / провайдер)
                    └┬──┬──┬──┘        └────▲─────┘
        Celery-задачи│  │  │S3              │
        ┌────────────┘  │  └──────┐         │
   ┌────▼───┐      ┌────▼────┐ ┌──▼──────┐  │
   │ worker │─────►│postgres │ │seaweedfs│  │
   │ (core) │      └─────────┘ └─────────┘  │
   └─┬───┬──┘                               │
     │   └──────────────────────────────────┘
     │ Redis: брокер Celery, pub/sub прогресса, кеш
     │ Qdrant: база знаний + требования/дефекты прошлых прогонов
     ▼
   LLM: Gemini / OpenAI / Anthropic / OpenAI-совместимый (ollama в профиле offline)

   cli — тот же core, запуск одной командой (обязательное требование ТЗ)
```

| Сервис | Каталог | Технологии | Порт (внутр.) | Владелец |
| :--- | :--- | :--- | :--- | :--- |
| `web` | `services/web` | React + TS + Vite + Tailwind + shadcn/ui, i18next, nginx | 8080 | сессия «Веб» |
| `api` | `services/api` | FastAPI, SQLAlchemy 2 + Alembic, Pydantic, boto3, qdrant-client | 8000 | сессия «Бэкенд» |
| `migrate` | `services/api` | тот же образ, `alembic upgrade head`, one-shot | — | сессия «Бэкенд» |
| `worker` | `services/worker` | Celery + `req_core` | — | сессия «Бэкенд» |
| `embedder` | `services/embedder` | FastAPI + sentence-transformers (`multilingual-e5-small`) | 8001 | сессия «Бэкенд» |
| `cli` | `services/cli` | `req_core` | — | сессия «Ядро» |
| `postgres`, `redis`, `qdrant`, `seaweedfs` | `deploy/` | — | 5432, 6379, 6333, 8333 | сессия «Инфраструктура» |
| `prometheus`, `grafana`, `loki`, `alloy`, экспортеры | `deploy/monitoring` | профиль `monitoring` | 9090, 3000 | сессия «Инфраструктура» |
| `ollama` / `ollama-gpu` | `deploy/` | профили `offline` / `gpu` | 11434 | сессия «Инфраструктура» |

Общие библиотеки:
- `packages/contracts` (`req_contracts`) — модели отчёта, критерии, события прогресса, конфиг LLM. **Владелец — main.**
  Изменения только согласованно, с подъёмом `SCHEMA_VERSION`. JSON Schema отчёта: `req_contracts/fixtures/report.schema.json`,
  пример отчёта для моков и тестов: `req_contracts/fixtures/sample_report.json`.
- `packages/core` (`req_core`) — агент: парсинг, нарезка, проверки, рендер отчёта, LLM-провайдеры. **Владелец — сессия «Ядро».**

## Публичный интерфейс ядра (`req_core`)

Воркер, API и CLI зависят только от этих функций. Сигнатуры зафиксированы в `packages/core/req_core/__init__.py`.

```python
parse_document(path: Path, *, name: str | None = None) -> ParsedDocument
validate_document(path: Path, llm: ProviderConfig, *, options: ValidationOptions | None = None,
                  on_progress: ProgressCallback | None = None, document_name: str | None = None) -> Report
render_report(report: Report, fmt: Literal["md", "json", "docx", "pdf"]) -> bytes
get_llm(cfg: ProviderConfig) -> LLMClient          # complete(), stream(), complete_json(schema)
list_models(cfg: ProviderConfig) -> list[str]      # для выпадающего списка моделей в вебе
answer_question(report: Report, history: list[ChatMessage], question: str, llm: ProviderConfig,
                knowledge_snippets: list[str] | None = None) -> Iterator[str]   # чат по отчёту, поток токенов
```

Требования к ядру:
- Конвейер — агенты bbc-agent (`req_core/agent`): чтение → правила-подсказки → нарезчик в два прохода (контроль
  покрытия) → планировщик и воркеры (инспектор по матрице «требование × критерий», шесть рецензентов набора, раунды
  до полного покрытия, деление большого документа под окно модели) → контроль достоверности кодом (цитаты, цитаты
  внутри объяснений, ссылки на несуществующие объекты) → верификатор (опровержение, слияние дублей; `verify_pass`)
  → вопросы автору и чек-лист → редакции по ответам автора (`ValidationOptions.answers`) → итог с предохранителями.
  Агенты общаются через граф памяти; модель отвечает свободным JSON по схеме из промта
  (`LLMClient.complete_reply`), окно модели контролируется до вызова (`ProviderConfig.context_tokens`).
- Схема отчёта 1.1 (изменение контракта): добавлено `Report.questions: [ClarifyingQuestion]` — `id` (`Q-01`),
  `question`, `why`, `addressee`, `priority` (blocker | important | minor), `finding_ids`, `options`. Поле
  необязательное, отчёты 1.0 читаются без изменений. В `ValidationOptions` — `ask_questions=True`, `max_questions=15`,
  `verify_pass` теперь по умолчанию `True`.
- Схема отчёта 1.2 (изменение контракта, все поля необязательные — отчёты 1.1 читаются): у `Finding` —
  `defect_type`, `grounding` (exact | fuzzy | line), `found_by`, `verifier_note`, `resolved_by`; у `SourceLocation` —
  `line_start`, `line_end`; у `CriterionCheck` — `assessed_by`; у `ClarifyingQuestion` — `requirement_ids`, `answer`,
  `resolution` (новые редакции требований, снятые дефекты); у `Conclusion` — `decision` (blocked | limited | ready),
  `development`, `testing`, `fixes`, `strengths`, `guard_note`; у `Report` — `document_title`, `skipped`
  (фрагменты «не требование»), `quality` (воронка кандидатов, привязка цитат, покрытие матрицы, окно модели, версии
  промтов). `ChecklistAnswer.partial`. `ProviderConfig.context_tokens`, `ValidationOptions.answers`.
- Ответ модели агентам — JSON по схеме из промта с разбором, спасением оборванного ответа и повтором;
  `complete_json` (Pydantic-схемы, нативный JSON-режим провайдера) остаётся в LLM-слое. temperature 0,
  повторы при 429/5xx.
- Провайдеры — собственный тонкий слой над официальными SDK (`google-genai`, `openai`, `anthropic`);
  `openai_compatible` = OpenAI SDK с `base_url` (Ollama, vLLM). LiteLLM не используем (лишняя зависимость в банковском контуре).
- `agent_version` — `git describe --always --dirty`, иначе переменная `AGENT_VERSION` (задаётся при сборке образа).

## Данные

**Postgres** (схема — сессия «Бэкенд», миграции Alembic):
`users`, `provider_settings` (ключи зашифрованы Fernet ключом `APP_ENCRYPTION_KEY`), `documents`, `runs`
(статус, стадия, провайдер, модель, usage, ошибка), `reports` (JSON отчёта), `finding_reviews`
(статус дефекта: `open | accepted | false_positive | fixed` + комментарий), `chat_messages`, `knowledge_items`, `audit_log`.

**SeaweedFS (S3 API)** — исходные файлы и выгрузки отчётов. Бакет `${S3_BUCKET}`. Код работает через boto3,
поэтому хранилище заменяемо на любое S3-совместимое (Garage, Ceph RGW, AWS S3).

**Qdrant** — коллекции `knowledge` (база знаний: пересказ критериев, глоссарий, внутренние шаблоны) и
`requirements` (требования и дефекты прошлых прогонов для поиска похожих). Размерность берётся из `embedder`.

**Redis** — брокер и backend Celery, канал `run:{run_id}:events` для прогресса, кеш ответов LLM.

## Потоки

1. Загрузка: `web` → `POST /api/documents` → файл в S3, запись в `documents`.
2. Прогон: `POST /api/runs` → запись `runs(queued)` → Celery-задача `reqcheck.run_validation(run_id)`.
3. Воркер: скачивает файл → берёт ключ провайдера из Postgres → ищет фрагменты базы знаний в Qdrant →
   `validate_document(..., on_progress=publish)` → события в Redis `run:{id}:events` → отчёт в `reports`,
   выгрузки MD/DOCX/PDF в S3 → индексирует требования и дефекты в Qdrant → `runs(done)`.
4. Прогресс: `GET /api/runs/{id}/events` (SSE) — API подписан на Redis-канал и пересылает `ProgressEvent`.
5. Чат: `POST /api/runs/{id}/chat` (SSE-поток токенов) — API вызывает `answer_question` напрямую.

Почему SSE, а не WebSocket: все потоки однонаправленные (сервер → клиент), а команды идут обычными POST.
SSE — это обычный HTTP: автопереподключение в браузере, без upgrade-заголовков в прокси.
Для прокси на хосте: `proxy_buffering off; proxy_read_timeout 1h;` на `/api/`.

## Профили docker compose

| Профиль | Что добавляет |
| :--- | :--- |
| (по умолчанию) | web, api, migrate, worker, embedder, postgres, redis, qdrant, seaweedfs |
| `monitoring` | prometheus, grafana, loki, alloy, postgres/redis-экспортеры |
| `offline` | ollama (CPU) с моделью, скачанной на этапе сборки; embedder с вшитой моделью; провайдер по умолчанию — `openai_compatible` |
| `gpu` | ollama с `deploy.resources.reservations.devices: nvidia` |
| `test` | тест-раннеры: `test-contracts`, `test-core`, `test-api`, `test-worker`, `test-embedder`, `test-web` |
| `cli` | `cli` — разовый прогон агента |

Профили включаются через `COMPOSE_PROFILES` в `.env`. Всё собирается из исходников при `docker compose up --build`.

## Соглашения

- **Тесты запускаются только в Docker** — на хосте не ставим Python/Node-зависимости и ничего не запускаем:
  `docker compose --profile test run --rm --build test-<сервис>`.
  У каждого сервиса в Dockerfile есть стадия `test`; тестовые сервисы описаны в `compose.yaml`.
- Тесты не ходят во внешние LLM: используется фейковый провайдер (`FakeLLM` в `req_core.testing`). Живой прогон —
  отдельная команда, требует ключа.
- Контекст сборки всех образов — корень репозитория (чтобы копировать `packages/*`).
- Python 3.12, менеджер пакетов `uv`, линтер `ruff`. Node 22 LTS, `pnpm`.
- Каждая ветка-сессия правит только свои каталоги. Общие файлы (`compose.yaml`, `.env.example`, `README.md`,
  `BACKLOG.md`) — только свой раздел, помеченный комментарием с именем сессии.
- Коммиты небольшие, после каждого завершённого шага; сообщение на английском в повелительном наклонении.
- Секреты только в `.env` (в git не попадает). Все переменные описаны в `.env.example`.
