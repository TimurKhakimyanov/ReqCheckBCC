# Изменения, которые инфраструктура просит внести в сервисы приложения

Сессия «Инфраструктура» не правит `services/*`, `packages/*` и сервисы приложений в `compose.yaml`.
Ниже — что нужно сделать владельцам, чтобы стек работал целиком. Метрики — подробно в [docs/monitoring.md](../monitoring.md).

## Бэкенд: `compose.yaml`, раздел «Бэкенд»

1. **`depends_on` на здоровые хранилища.** У `qdrant` и `seaweedfs` теперь есть healthcheck; `seaweedfs`
   становится healthy только после создания бакета `S3_BUCKET`. Замените в `api` (и добавьте в `worker`):
   ```yaml
   qdrant: { condition: service_healthy }
   seaweedfs: { condition: service_healthy }
   ```
   Иначе первый запуск может упасть на отсутствующем бакете.
2. **Ротация логов.** У инфраструктурных сервисов `logging: *infra-logging` (json-file, 5×10 МБ). Якорь объявлен
   в сервисе `postgres` и ниже по файлу, поэтому для `web`, `api`, `migrate`, `worker`, `embedder`, `cli`
   проще всего вынести его в начало файла как `x-logging: &logging` (main) или продублировать:
   ```yaml
   logging: { driver: json-file, options: { max-size: "10m", max-file: "5" } }
   ```
3. **Healthcheck и лимиты** для `api` (`GET /api/health`), `worker` (`celery inspect ping` или файл-сердцебиение),
   `embedder`, `web` — по аналогии с инфраструктурой, плюс `deploy.resources.limits`.
4. ~~Метрики воркера на `:9101`~~ — сделано в `claude/backend-4accf6` (`WORKER_METRICS_PORT=9101`,
   `PROMETHEUS_MULTIPROC_DIR=/tmp/prometheus`).
5. ~~Имя очереди~~ — сверено: очередь `celery`, Redis db0; redis-exporter настроен на `db0=celery`.

## Бэкенд: код

Метрики реализованы по docs/monitoring.md (сверка с `claude/backend-4accf6@15b20f8`, 2026-11-27); дашборд и
правила используют эти имена. Пожелания, не блокирующие:
1. Латентность и ошибки отдельных вызовов LLM внутри прогона (сейчас из воркера — только итоговые `outcome=ok`).
2. Токены чата (`reqcheck_llm_tokens_total` с теми же метками из `api`).
3. Логи — JSON в stdout с полем `level` (Alloy разметит уровень для Loki).

## Веб

1. nginx в `web` не должен проксировать `/metrics` и `/api/metrics` наружу (если `/api/*` → `api:8000/*` со
   срезанием префикса — закрыть `location = /api/metrics { return 404; }`).
2. Для SSE на `/api/` внутри `web`: `proxy_buffering off; proxy_read_timeout 1h;` (то же, что в
   `deploy/nginx/host-example.conf` на хосте).

## Профиль offline / gpu

Настройки ИИ больше не задаются в `.env`. При включении `offline` или `gpu` в «Администрировании» выбирают
провайдера `openai_compatible` с адресом `http://ollama:11434/v1` и моделью из `OLLAMA_MODELS`. Если ключ
пуст, бэкенду стоит подставлять любой непустой (например `ollama`): Ollama ключ не проверяет, а OpenAI SDK
требует непустой. Ядру: `list_models` для `openai_compatible` может брать список из `GET /v1/models`.

## `.env` после перехода на админку (раунд 2026-11-27)

`.env.example` содержит только секреты и логины; `x-app-env.DATABASE_URL` получил `${POSTGRES_DB:-reqcheck}`
(иначе без `POSTGRES_DB` в `.env` имя базы было бы пустым). Владельцам сервисов приложений: убрать из своего
`environment` переменные, которых больше нет в `.env.example` (`LLM_*`, `*_API_KEY` провайдеров,
`OPENAI_COMPATIBLE_*`, `REQCHECK_*`, `EMBEDDINGS_*`, `RUN_TIMEOUT_S`, `SESSION_TTL_HOURS`, `COOKIE_SECURE`,
`MAX_UPLOAD_MB`, `WORKER_CONCURRENCY`), или дать им значения по умолчанию `${VAR:-…}`.
Embedder в офлайне должен иметь модель внутри образа (аргумент сборки `EMBEDDINGS_MODEL` уже есть в compose).
