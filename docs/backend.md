# Бэкенд: API, воркер, эмбеддинги

Три сервиса на Python 3.12 (`uv`, образы собираются из корня репозитория). HTTP-контракт с вебом —
[api.md](api.md), общая схема — [architecture.md](architecture.md).

| Сервис | Что делает |
| :--- | :--- |
| `api` (`services/api`) | FastAPI: вход, настройки провайдеров, документы, прогоны, SSE прогресса, отчёты и выгрузки, статусы дефектов, чат по отчёту, поиск, база знаний, расход, аудит. OpenAPI — `/api/openapi.json`, Swagger UI — `/api/docs` |
| `migrate` | тот же образ, `alembic upgrade head` перед стартом api и worker |
| `worker` (`services/worker`) | Celery-задача `reqcheck.run_validation`: файл из S3 → ключ провайдера из Postgres → фрагменты базы знаний из Qdrant → `req_core.validate_document` → отчёт в Postgres, выгрузки MD/DOCX/PDF в S3 → требования и дефекты в Qdrant |
| `embedder` (`services/embedder`) | `POST /embed {texts, kind: query\|passage}`, `GET /info`. По умолчанию локальная `intfloat/multilingual-e5-small` на CPU; модель скачивается при сборке образа, в работе интернет не нужен |

## Ключи и настройки

`.env` содержит только секреты установки ([deployment.md](deployment.md#первый-запуск)). Ключи приложения можно
получить и так: `docker compose run --rm --no-deps api python -m app.keygen` — печатает `APP_ENCRYPTION_KEY` и
`APP_SECRET_KEY`.

Вход — `ADMIN_USERNAME` / `ADMIN_PASSWORD` (админ создаётся при первом старте, потом пароль меняется в кабинете).
Всё про ИИ задаётся только в кабинете, а не в `.env`: ключи и адреса провайдеров (`/api/providers`, ключи хранятся
в Postgres зашифрованными — Fernet, `APP_ENCRYPTION_KEY`), провайдер и модель по умолчанию, таймаут прогона, пауза и
число попыток LLM, размер пакета и параллельность, эмбеддинги (`/api/settings`). Локальный OpenAI-совместимый сервер
(vLLM, Ollama) подключается указанием адреса, ключ не нужен. Кнопка «Проверить» в форме провайдера сразу возвращает
список моделей — до сохранения. Не меняйте `APP_ENCRYPTION_KEY` после ввода ключей — их придётся ввести заново.

Кэш ответов модели воркера — том `llm-cache` (`LLM_CACHE_DIR`, по умолчанию `/cache/llm`; пустое значение выключает
кэш): повторный прогон того же документа с теми же настройками идёт за секунды.

## Прогон и прогресс

`POST /api/runs` ставит задачу в очередь Redis; воркер публикует события в канал `run:{id}:events`, api отдаёт их
по SSE (`GET /api/runs/{id}/events`, сначала текущее состояние). Отмена — флаг в Redis: ядро прерывается на
ближайшем событии прогресса. Прогон дольше `run_timeout_s` (настройки) завершается ошибкой. Ошибки провайдера
(неверный ключ, лимит 429, таймаут) пишутся в `runs.error` понятным текстом.

## Поиск и база знаний

Qdrant: коллекция `knowledge` (при первом старте туда индексируется пересказ критериев 29148/830; загруженные
PDF/DOCX/MD/TXT и заметки режутся на фрагменты) и `requirements` (требования и дефекты прошлых прогонов). Фрагменты
базы знаний подмешиваются в прогон (`ValidationOptions.knowledge_snippets`) и в чат. Эмбеддинги: по умолчанию
локальная модель внутри `embedder` (вшивается при сборке, аргумент `EMBEDDINGS_MODEL`); в настройках можно выбрать
Gemini или OpenAI — api передаёт ключ в каждом запросе к embedder. После смены модели коллекции пересоздаются,
база знаний и отчёты индексируются заново в фоне.

## Наблюдаемость

Логи — JSON в stdout (одна строка на событие, поля `service`, `run_id`, `route`, `duration_ms`).
Метрики Prometheus: `api:8000/metrics`, `worker:9101/metrics`, `embedder:8001/metrics` (только внутренняя сеть),
подробно — [monitoring.md](monitoring.md). `GET /api/health` проверяет Postgres, Redis, Qdrant, S3 и embedder.

## Тесты

`test-api`, `test-worker`, `test-embedder` (команды — в [README](../README.md#тесты)): Postgres и Redis настоящие,
S3 и Qdrant — в памяти, ядро — мок на `sample_report.json`.

Уточнения контракта с вебом, ядром и инфраструктурой — [contract-changes/backend.md](contract-changes/backend.md).
