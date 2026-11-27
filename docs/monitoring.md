# Мониторинг ReqCheck

Профиль `monitoring`: Prometheus (метрики), Loki + Alloy (логи контейнеров), Grafana (дашборд «ReqCheck»),
postgres-exporter, redis-exporter, cAdvisor (ресурсы контейнеров). Наружу открыта только Grafana:
`http://${BIND_ADDR}:${GRAFANA_PORT}`, логин `GRAFANA_ADMIN_USER` / `GRAFANA_ADMIN_PASSWORD`.

| Файл | Что внутри |
| :--- | :--- |
| `deploy/monitoring/prometheus.yml` | цели сбора (scrape) |
| `deploy/monitoring/alerts.yml` | правила оповещений (видны в Prometheus и Grafana; Alertmanager не входит в стек) |
| `deploy/monitoring/loki.yaml` | Loki single binary, хранение на диске, срок `LOKI_RETENTION` |
| `deploy/monitoring/config.alloy` | сбор логов контейнеров этого compose-проекта через docker.sock |
| `deploy/monitoring/grafana/` | provisioning: источники `prometheus`, `loki` и дашборд `reqcheck.json` |

## Цели Prometheus

| job | Адрес | Кто отдаёт |
| :--- | :--- | :--- |
| `api` | `api:8000/metrics` | сессия «Бэкенд» |
| `worker` | `worker:9101/metrics` | сессия «Бэкенд» |
| `embedder` | `embedder:8001/metrics` | сессия «Бэкенд» (необязательно) |
| `postgres` | `postgres-exporter:9187` | инфраструктура |
| `redis` | `redis-exporter:9121` (включая длину очереди Celery) | инфраструктура |
| `qdrant` | `qdrant:6333/metrics` (Bearer `QDRANT_API_KEY`) | Qdrant |
| `seaweedfs` | `seaweedfs:9324` | SeaweedFS |
| `cadvisor` | `cadvisor:8080` | ресурсы контейнеров |
| `prometheus`, `loki`, `alloy`, `grafana` | — | сам мониторинг |

На хосте могут работать чужие контейнеры, поэтому в мониторинг попадают только контейнеры проектов ReqCheck.
Alloy берёт логи по метке `com.docker.compose.project` = имя текущего проекта. Prometheus оставляет
метрики cAdvisor только для проектов, чьё имя начинается с `reqcheck` (`metric_relabel_configs` в `prometheus.yml`).
Alloy и cAdvisor подключают `docker.sock` и `/var/lib/docker` только на чтение.

Пока сервис приложения не отдаёт `/metrics`, его цель в Prometheus будет `down` — дашборд при этом работает,
панели приложения просто пустые.

## Метрики приложения

Метрики реализованы в ветке бэкенда (`services/api/app/metrics.py`, `services/worker/worker/metrics.py`,
`services/embedder/embedder/main.py`); источник правды — код, таблица ниже — сверка на 2026-11-27.
Все имена начинаются с `reqcheck_`, библиотека `prometheus_client`. `/metrics` и `/livez` живут в корне сервиса
(не под `/api`) и через `web` наружу не проксируются.

### API (`api:8000/metrics`)

| Метрика | Тип | Метки | Смысл |
| :--- | :--- | :--- | :--- |
| `reqcheck_http_requests_total` | counter | `method`, `route`, `status` | HTTP-запросы. `route` — шаблон пути FastAPI (`/api/runs/{run_id}`, иначе `unmatched`), `status` — числовой код. |
| `reqcheck_http_request_duration_seconds` | histogram | `method`, `route` | Время ответа. Бакеты `0.01 … 30` с. |
| `reqcheck_sse_connections` | gauge | `kind` = `progress` \| `chat` | Открытые SSE-потоки. |
| `reqcheck_runs_created_total` | counter | `provider` | Поставленные в очередь прогоны. |
| `reqcheck_documents_uploaded_total` | counter | `format` | Загруженные документы. |
| `reqcheck_logins_total` | counter | `result` = `ok` \| `failed` | Попытки входа. |
| `reqcheck_chat_messages_total` | counter | `provider`, `result` = `ok` \| `error` | Вопросы в чате по отчёту. |

### Воркер (`worker:9101/metrics`)

Пул Celery — потоки (`worker_pool=threads`), поэтому обычный `start_http_server(9101)` без multiprocess-режима.

| Метрика | Тип | Метки | Смысл |
| :--- | :--- | :--- | :--- |
| `reqcheck_worker_runs_total` | counter | `status` = `done` \| `failed` \| `cancelled`, `provider` | Завершённые прогоны. |
| `reqcheck_worker_run_duration_seconds` | histogram | `status` | Длительность прогона. Бакеты `10, 30, 60, 120, 300, 600, 1200, 1800, 3600` с. |
| `reqcheck_worker_runs_in_progress` | gauge | — | Прогоны, выполняющиеся сейчас. |
| `reqcheck_llm_calls_total` | counter | `provider`, `model` | Вызовы LLM за прогоны. |
| `reqcheck_llm_tokens_total` | counter | `provider`, `model`, `kind` = `prompt` \| `completion` | Токены по `usage` провайдера. |
| `reqcheck_llm_cost_usd_total` | counter | `provider`, `model` | Оценка стоимости, USD. |
| `reqcheck_findings_total` | counter | `severity` = `critical` \| `major` \| `minor` | Найденные дефекты. |

LLM-метрики воркер добавляет **одним шагом по завершении прогона**, поэтому графики «в минуту» ступенчатые;
итоги за период (`increase(...[$__range])`) точные. Токены чата сейчас не считаются.

### Embedder (`embedder:8001/metrics`)

| Метрика | Тип | Метки | Смысл |
| :--- | :--- | :--- | :--- |
| `reqcheck_embedder_texts_total` | counter | `kind` = `query` \| `passage` | Тексты, переведённые в векторы. |
| `reqcheck_embedder_request_seconds` | histogram | — | Время запроса `/embed`. |
| `reqcheck_embedder_errors_total` | counter | — | Ошибки эмбеддинга. |

### Чего нет (пожелания бэкенду, не блокирует)

Латентность и исходы отдельных вызовов LLM (`reqcheck_llm_request_duration_seconds`, ошибки/повторы по провайдеру),
длительность стадий конвейера, токены чата. Когда появятся — добавить панели в дашборд.

### Очередь Celery

Отдельный экспортер не нужен: бэкенд кладёт задачи в очередь `reqcheck` (`task_default_queue`), Redis db0
(`REDIS_URL=redis://…/0`). redis-exporter читает длину этого списка (`REDIS_EXPORTER_CHECK_SINGLE_KEYS=db0=reqcheck`)
→ метрика `redis_key_size{key="reqcheck"}`. Если бэкенд сменит очередь или базу — поправьте переменную
в `compose.yaml` (сервис `redis-exporter`), дашборд и правило `CeleryQueueBacklog`.

### Логи

Alloy забирает stdout/stderr всех контейнеров проекта и ставит метки `service` (имя сервиса compose),
`container`, `project`, `stream`, `level`. `level` берётся из поля `level` JSON-строки лога, иначе — из
слова `DEBUG/INFO/WARNING/ERROR/CRITICAL` в строке. Рекомендация для приложений: логировать в stdout
одной JSON-строкой на событие с полями `level`, `logger`, `message`, `run_id` (run_id — в тело, не в метку).

Примеры запросов в Grafana → Explore → Loki:

```logql
{service="worker", level="error"}
{service="api"} | json | run_id = "…"
sum by (service) (count_over_time({level=~"error|critical"}[5m]))
```

## Дашборд «ReqCheck»

Открывается домашней страницей Grafana. Разделы: доступность целей; API (rps по статусу, доля 4xx/5xx,
p95 по маршрутам); прогоны и очередь (итоги за период, p50/p95 длительности, очередь Celery и прогоны в
работе, дефекты по критичности); LLM прогонов (токены за период и в минуту, вызовы, стоимость в USD);
активность и поиск (загрузки и запуски, входы и чат, SSE-потоки, эмбеддинги); ресурсы (CPU и память по сервисам, Postgres, Redis); логи (ошибки по сервисам и поток логов).
Дашборд хранится в git и при изменении в UI не сохраняется — правьте `reqcheck.json`.

## Оповещения

`alerts.yml`: цель недоступна 2 мин, Postgres/Redis недоступны, >5% ответов API с 5xx, очередь Celery >20
задач 10 мин, 3+ упавших прогона за 30 мин, >20% ошибок чата у провайдера, >5 ошибок embedder за 10 мин,
>20 неудачных входов за 10 мин, Redis занял >90% maxmemory.
Доставка (почта, Telegram, Mattermost) — через Grafana Alerting → Contact points или Alertmanager (в бэклоге).
