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
4. ~~Метрики воркера на `:9101`~~ — сделано в `claude/backend-4accf6` (`WORKER_METRICS_PORT=9101`, пул потоков,
   multiprocess-режим не нужен).
5. ~~Имя очереди~~ — сверено: очередь `reqcheck`, Redis db0; redis-exporter настроен на `db0=reqcheck`.

## Бэкенд: код

Метрики реализованы, мониторинг подстроен под фактические имена (сверка 2026-11-27, см. docs/monitoring.md).
Пожелания, не блокирующие:
1. Латентность и исход каждого вызова LLM (`reqcheck_llm_request_duration_seconds{provider,model}`,
   `reqcheck_llm_requests_total{provider,model,outcome}`) — сейчас видно только итоговые вызовы и токены за прогон.
2. Длительность стадий конвейера (`reqcheck_run_stage_duration_seconds{stage}`).
3. Токены чата (`reqcheck_llm_tokens_total` с теми же метками из `api`).
4. Логи — JSON в stdout с полем `level` (Alloy разметит уровень для Loki).

## Веб

1. nginx в `web` не должен проксировать `/metrics` и `/api/metrics` наружу (если `/api/*` → `api:8000/*` со
   срезанием префикса — закрыть `location = /api/metrics { return 404; }`).
2. Для SSE на `/api/` внутри `web`: `proxy_buffering off; proxy_read_timeout 1h;` (то же, что в
   `deploy/nginx/host-example.conf` на хосте).

## Профиль offline / gpu

При включении `offline` или `gpu` в `.env` ставьте `LLM_PROVIDER=openai_compatible`,
`OPENAI_COMPATIBLE_BASE_URL=http://ollama:11434/v1`, `OPENAI_COMPATIBLE_MODEL=<модель из OLLAMA_MODELS>`,
`OPENAI_COMPATIBLE_API_KEY=ollama` (Ollama ключ не проверяет, но OpenAI SDK требует непустой).
Ядру: `list_models` для `openai_compatible` может брать список из `GET /v1/models`.
Embedder в офлайне должен иметь модель внутри образа (аргумент сборки `EMBEDDINGS_MODEL` уже есть в compose).
