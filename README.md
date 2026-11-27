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

Весь стек собирается из исходников и поднимается одной командой на одном Linux-сервере.
Подробности: мониторинг — [docs/monitoring.md](docs/monitoring.md), пример nginx — [deploy/nginx/host-example.conf](deploy/nginx/host-example.conf).

### Требования к серверу

| | Минимум | Рекомендуется |
| :--- | :--- | :--- |
| ОС | Linux x86_64 (Ubuntu 22.04+/RHEL 9+) | — |
| Docker | Docker Engine 24+ и Compose v2.24+ (`docker compose version`) | последние стабильные |
| CPU / RAM | 4 vCPU / 8 ГБ (внешний LLM-провайдер) | 8 vCPU / 16 ГБ; профиль `offline` — от 32 ГБ |
| Диск | 30 ГБ (образы, данные, логи) | SSD 100 ГБ+; модели Ollama — ещё 5–50 ГБ |
| GPU (профиль `gpu`) | NVIDIA с драйвером + nvidia-container-toolkit | VRAM под выбранную модель |
| Сеть | интернет на время сборки; во время работы — только до LLM-провайдера (или вовсе без сети в `offline`) | — |

Наружу стек публикует только два порта и только на `BIND_ADDR` (по умолчанию `127.0.0.1`): веб `WEB_PORT`
и Grafana `GRAFANA_PORT`. Postgres, Redis, Qdrant, SeaweedFS, Prometheus, Loki доступны только внутри
docker-сети `backend`. TLS, домен и обратный прокси настраиваются на хосте (nginx — пример по ссылке выше:
без буферизации и с таймаутом 1 ч для SSE на `/api/`, `client_max_body_size`).

### Первый запуск

```bash
git clone <репозиторий> reqcheck && cd reqcheck
cp .env.example .env
```

В `.env` обязательно заменить все `change-me`: `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `QDRANT_API_KEY`,
`S3_SECRET_KEY`, `GRAFANA_ADMIN_PASSWORD`, а также `APP_SECRET_KEY`, `APP_ENCRYPTION_KEY`, `ADMIN_PASSWORD`
(раздел бэкенда). Секрет можно сгенерировать прямо в Docker, ничего не ставя на хост:

```bash
docker run --rm alpine:3 sh -c 'tr -dc A-Za-z0-9 < /dev/urandom | head -c 40; echo'
```

Пароли Postgres и ключи S3 применяются при **первой** инициализации томов; чтобы сменить их потом,
меняйте и в `.env`, и в самой базе (`ALTER USER ...`). Затем:

```bash
docker compose up -d --build
docker compose ps                     # все сервисы healthy / running
docker compose --profile test run --rm --build test-infra   # смоук-тест хранилищ
```

### Профили

Включаются переменной `COMPOSE_PROFILES` в `.env` (через запятую) или флагом `--profile`.

| Профиль | Что добавляет |
| :--- | :--- |
| (без профиля) | web, api, migrate, worker, embedder, postgres, redis, qdrant, seaweedfs |
| `monitoring` | prometheus, grafana, loki, alloy, postgres-exporter, redis-exporter, cadvisor |
| `offline` | ollama на CPU с моделями, вшитыми в образ |
| `gpu` | ollama на NVIDIA GPU (тот же образ и тот же адрес `http://ollama:11434`) |
| `backup` | сервис `backup` — бэкап и восстановление (запускается разово) |
| `test` | тест-раннеры, в том числе `test-infra` |
| `cli` | разовый прогон агента из командной строки |

`offline` и `gpu` взаимоисключающие: оба сервиса отвечают по имени `ollama`, включайте один.

### Обновление и миграции

```bash
git pull
docker compose --profile backup run --rm backup     # бэкап перед обновлением
docker compose up -d --build                         # пересборка; migrate применит миграции Alembic
```

Старые образы не удаляются автоматически. Не запускайте `docker image prune` или `docker system prune` на сервере, где работают
чужие контейнеры: эти команды затрагивают весь Docker. Удаляйте только образы ReqCheck по имени.

Сервис `migrate` выполняет `alembic upgrade head` при каждом `up` и запускает `api`/`worker` только после
успешной миграции. Версии образов инфраструктуры закреплены в `compose.yaml`; при смене **мажорной** версии
Postgres нужен дамп и восстановление (см. «Бэкапы»), а не просто смена тега.

### Офлайн-установка (локальная LLM)

1. В `.env`: `COMPOSE_PROFILES=monitoring,offline`, `OLLAMA_MODELS=qwen3:8b` (через запятую можно несколько),
   `LLM_PROVIDER=openai_compatible`, `OPENAI_COMPATIBLE_BASE_URL=http://ollama:11434/v1`,
   `OPENAI_COMPATIBLE_MODEL=qwen3:8b`, `OPENAI_COMPATIBLE_API_KEY=ollama`, `EMBEDDINGS_PROVIDER=local`.
2. `docker compose up -d --build` **на машине с интернетом**: модели скачиваются при сборке и лежат внутри
   образа `reqcheck-ollama:local`, модель эмбеддингов — внутри образа `embedder`.
3. Дальше сервер работает без интернета. Перенос на изолированный сервер без сборки — через
   `docker save`/`docker load` (готовый комплект — в бэклоге).

Сменили список моделей — пересоберите: `docker compose build ollama && docker compose up -d ollama`.
Память контейнера ограничена `OLLAMA_MEM_LIMIT` (по умолчанию 16g) — модель должна в неё помещаться.

### GPU (NVIDIA)

На хосте нужны драйвер NVIDIA и [nvidia-container-toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html):

```bash
sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker
docker run --rm --gpus all ubuntu nvidia-smi      # проверка: видна видеокарта
```

Затем в `.env` — те же настройки, что для офлайна, но `COMPOSE_PROFILES=monitoring,gpu`. Сервис `ollama-gpu`
резервирует все GPU (`deploy.resources.reservations.devices`) и доступен по адресу `http://ollama:11434`.
Проверка: `docker compose exec ollama-gpu ollama ps` — в колонке PROCESSOR должно быть `100% GPU`.

### Мониторинг

Профиль `monitoring` (включён в `.env.example` по умолчанию). Grafana: `http://<BIND_ADDR>:<GRAFANA_PORT>`,
логин `GRAFANA_ADMIN_USER`/`GRAFANA_ADMIN_PASSWORD`, домашний дашборд — «ReqCheck» (API, прогоны, очередь
Celery, токены LLM, ресурсы, логи). Логи всех контейнеров — в Loki (Grafana → Explore). Хранение:
`PROMETHEUS_RETENTION` (15d), `LOKI_RETENTION` (14 дней). Логи Docker ротируются (5 файлов по 10 МБ на контейнер).

### Бэкапы

```bash
docker compose --profile backup run --rm backup          # → ./backups/<UTC-время>/
docker compose --profile backup run --rm backup list     # список бэкапов
```

В бэкап входят: дамп Postgres (`postgres.dump`), снапшоты коллекций Qdrant (`qdrant/*.snapshot`), копия
бакета S3 (`s3/`) и `manifest.json`. Redis не бэкапится (очередь и кеш). Каталоги старше `BACKUP_KEEP_DAYS`
удаляются. Расписание — cron на хосте, например ежедневно в 03:00:

```cron
0 3 * * * cd /opt/reqcheck && docker compose --profile backup run --rm -T backup >> backups/backup.log 2>&1
```

Копируйте `./backups` на другой сервер/хранилище — бэкап на том же диске не спасёт от его потери.

**Восстановление** (перезаписывает текущие данные):

```bash
docker compose stop web api worker
docker compose --profile backup run --rm backup restore 20261127T030000Z --yes
docker compose up -d
```

Восстановление на новый сервер: развернуть стек с тем же `.env`, скопировать каталог бэкапа в `./backups/`,
выполнить команды выше.

### Полезные команды

```bash
docker compose ps                         # состояние и healthcheck
docker compose logs -f api worker         # логи
docker compose down                       # остановить (данные в томах сохраняются)
docker compose down -v                    # остановить и УДАЛИТЬ все данные ReqCheck (только тома этого проекта)
```

<!-- ===================== Раздел сессии «Бэкенд» ===================== -->
## API и воркер

> Раздел дописывает сессия «Бэкенд».

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
