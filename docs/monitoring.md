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

## Контракт метрик приложения

Все метрики приложения начинаются с `reqcheck_`. Библиотека — `prometheus_client`. Метки — только из
перечисленных ниже, с ограниченным набором значений (никаких `run_id`, `user`, полного URL).

### API (`api:8000/metrics`)

| Метрика | Тип | Метки | Смысл |
| :--- | :--- | :--- | :--- |
| `reqcheck_http_requests_total` | counter | `method`, `route`, `status` | Все HTTP-запросы. `route` — шаблон пути FastAPI (`/api/runs/{run_id}`), `status` — числовой код (`200`, `404`, `500`). |
| `reqcheck_http_request_duration_seconds` | histogram | `method`, `route` | Время ответа. **SSE-эндпоинты не включать** (они длятся минутами). Бакеты: `0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30`. |
| `reqcheck_sse_connections` | gauge | `stream` = `run_events` \| `chat` | Открытые SSE-потоки. |

Сам `/metrics` и `/api/health` в счётчики не включать.

### Воркер (`worker:9101/metrics`)

Celery работает в режиме prefork, поэтому метрики собираются в multiprocess-режиме `prometheus_client`:
`PROMETHEUS_MULTIPROC_DIR=/tmp/prometheus` (каталог очищается при старте воркера), HTTP-сервер метрик
поднимается в главном процессе (`MultiProcessCollector`) на порту `WORKER_METRICS_PORT=9101`.
Для gauge — `multiprocess_mode="livesum"`.

| Метрика | Тип | Метки | Смысл |
| :--- | :--- | :--- | :--- |
| `reqcheck_runs_total` | counter | `status` = `done` \| `failed` \| `cancelled`, `provider` | Завершённые прогоны. |
| `reqcheck_run_duration_seconds` | histogram | `status`, `provider` | Длительность прогона от старта задачи до финала. Бакеты: `10, 30, 60, 120, 300, 600, 1200, 1800, 3600`. |
| `reqcheck_run_stage_duration_seconds` | histogram | `stage` | Длительность стадии конвейера (значения `stage` — из `req_contracts.events`). Бакеты как выше плюс `1, 5`. |
| `reqcheck_runs_in_progress` | gauge (livesum) | — | Прогоны, выполняющиеся сейчас. |
| `reqcheck_findings_total` | counter | `severity` | Найденные дефекты (по завершённым прогонам). |
| `reqcheck_llm_requests_total` | counter | `provider`, `model`, `outcome` = `ok` \| `error` \| `retry` | Вызовы LLM. `retry` — неудачная попытка, после которой будет повтор. |
| `reqcheck_llm_request_duration_seconds` | histogram | `provider`, `model` | Время одного вызова LLM. Бакеты: `0.5, 1, 2, 5, 10, 20, 30, 60, 120, 180`. |
| `reqcheck_llm_tokens_total` | counter | `provider`, `model`, `type` = `input` \| `output` | Токены по данным `usage` провайдера. |

Чат по отчёту вызывает LLM из API, поэтому `reqcheck_llm_*` с теми же именами и метками отдаёт и `api`
(дашборд суммирует по всем целям).

### Очередь Celery

Отдельный экспортер не нужен: redis-exporter читает длину списка `celery` в db0
(`REDIS_EXPORTER_CHECK_SINGLE_KEYS=db0=celery`) → метрика `redis_key_size{key="celery"}`.
Если бэкенд переименует очередь или базу Redis, поправьте эту переменную в `compose.yaml` (сервис `redis-exporter`).

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
работе, p95 стадий); LLM (токены за период и в минуту по моделям, исходы запросов, p95 латентности);
ресурсы (CPU и память по сервисам, Postgres, Redis); логи (ошибки по сервисам и поток логов).
Дашборд хранится в git и при изменении в UI не сохраняется — правьте `reqcheck.json`.

## Оповещения

`alerts.yml`: цель недоступна 2 мин, Postgres/Redis недоступны, >5% ответов API с 5xx, очередь Celery >20
задач 10 мин, >20% ошибок LLM у провайдера, 3+ упавших прогона за 30 мин, Redis занял >90% maxmemory.
Доставка (почта, Telegram, Mattermost) — через Grafana Alerting → Contact points или Alertmanager (в бэклоге).
