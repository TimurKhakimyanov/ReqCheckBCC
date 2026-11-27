# ReqCheck — агент проверки требований

ИИ-агент статической проверки документа с требованиями по ISO/IEC/IEEE 29148:2018 (п. 5.2.5, 5.2.6)
и IEEE Std 830-1998 (п. 4.3). Выделяет требования, проверяет каждое и набор целиком, пишет отчёт на русском.
Есть CLI (одна команда) и веб-интерфейс со стеком для развёртывания у себя.

- Постановка: [docs/task.md](docs/task.md)
- Архитектура: [docs/architecture.md](docs/architecture.md), HTTP API: [docs/api.md](docs/api.md)
- Бэклог: [BACKLOG.md](BACKLOG.md)

<!-- ===================== Раздел сессии «Ядро» ===================== -->
## Быстрый прогон агента (CLI)

> Раздел дописывает сессия «Ядро»: как получить ключ LLM, куда положить, команда запуска, куда ляжет отчёт.

<!-- ===================== Раздел сессии «Инфраструктура» ===================== -->
## Развёртывание

> Раздел дописывает сессия «Инфраструктура».

```bash
cp .env.example .env   # заменить все change-me
docker compose up -d --build
```

<!-- ===================== Раздел сессии «Бэкенд» ===================== -->
## API и воркер

Три сервиса на Python 3.12 (`uv`, образы собираются из корня репозитория):

| Сервис | Что делает |
| :--- | :--- |
| `api` (`services/api`) | FastAPI: вход, настройки провайдеров, документы, прогоны, SSE прогресса, отчёты и выгрузки, статусы дефектов, чат по отчёту, поиск, база знаний, расход, аудит. OpenAPI — `/api/openapi.json`, Swagger UI — `/api/docs` |
| `migrate` | тот же образ, `alembic upgrade head` перед стартом api и worker |
| `worker` (`services/worker`) | Celery-задача `reqcheck.run_validation`: файл из S3 → ключ провайдера из Postgres → фрагменты базы знаний из Qdrant → `req_core.validate_document` → отчёт в Postgres, выгрузки MD/DOCX/PDF в S3 → требования и дефекты в Qdrant |
| `embedder` (`services/embedder`) | `POST /embed {texts, kind: query\|passage}`, `GET /info`. По умолчанию локальная `intfloat/multilingual-e5-small` на CPU; модель скачивается при сборке образа, в работе интернет не нужен |

**Первый запуск.** Перед `docker compose up` задайте в `.env` пароль админа и ключи:

```bash
docker compose run --rm --no-deps api python -m app.keygen   # печатает APP_ENCRYPTION_KEY и APP_SECRET_KEY
```

Вход — `ADMIN_USERNAME` / `ADMIN_PASSWORD` (админ создаётся при первом старте, потом пароль меняется в кабинете).
Ключи LLM вводятся в кабинете и хранятся в Postgres зашифрованными (Fernet, `APP_ENCRYPTION_KEY`). Если ключ уже есть
в `.env` (`GEMINI_API_KEY` и т. д.), api при старте запишет его в кабинет, пока там пусто.
Не меняйте `APP_ENCRYPTION_KEY` после ввода ключей — их придётся ввести заново.

**Прогон и прогресс.** `POST /api/runs` ставит задачу в очередь Redis; воркер публикует события в канал `run:{id}:events`,
api отдаёт их по SSE (`GET /api/runs/{id}/events`, сначала текущее состояние). Отмена — флаг в Redis: ядро прерывается
на ближайшем событии прогресса. Прогон дольше `RUN_TIMEOUT_S` завершается ошибкой. Ошибки провайдера (неверный ключ,
лимит 429, таймаут) пишутся в `runs.error` понятным текстом.

**Поиск и база знаний.** Qdrant: коллекция `knowledge` (при первом старте туда индексируется пересказ критериев
29148/830; загруженные PDF/DOCX/MD/TXT и заметки режутся на фрагменты) и `requirements` (требования и дефекты прошлых
прогонов). Фрагменты базы знаний подмешиваются в прогон (`ValidationOptions.knowledge_snippets`) и в чат.
Эмбеддинги: `EMBEDDINGS_PROVIDER=local|gemini|openai`. При смене модели меняется размерность — коллекции
пересоздаются, а api при старте переиндексирует базу знаний и отчёты.

**Наблюдаемость.** Логи — JSON в stdout (одна строка на событие, поля `service`, `run_id`, `route`, `duration_ms`).
Метрики Prometheus: `api:8000/metrics`, `worker:9101/metrics`, `embedder:8001/metrics` (только внутренняя сеть).
`GET /api/health` проверяет Postgres, Redis, Qdrant, S3 и embedder.

**Тесты** — в общем разделе ниже (`test-api`, `test-worker`, `test-embedder`): Postgres и Redis настоящие, S3 и Qdrant —
в памяти, ядро — мок на `sample_report.json`.

Уточнения контракта с вебом, ядром и инфраструктурой — [docs/contract-changes/backend.md](docs/contract-changes/backend.md).

<!-- ===================== Раздел сессии «Веб» ===================== -->
## Веб-интерфейс

> Раздел дописывает сессия «Веб».

<!-- ===================== Общий раздел ===================== -->
## Тесты

Все тесты запускаются только в Docker:

```bash
docker compose --profile test run --rm --build test-contracts
docker compose --profile test run --rm --build test-core
docker compose --profile test run --rm --build test-api
docker compose --profile test run --rm --build test-worker
docker compose --profile test run --rm --build test-embedder
docker compose --profile test run --rm --build test-web
```
