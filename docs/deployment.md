# Развёртывание Zoe (ReqCheck)

Весь стек собирается из исходников и поднимается одной командой на одном сервере. Короткая версия — в
[README](../README.md#веб-интерфейс-и-стек); здесь подробности. Все настройки — [configuration.md](configuration.md),
мониторинг — [monitoring.md](monitoring.md), пример nginx — [deploy/nginx/host-example.conf](../deploy/nginx/host-example.conf).

## Требования к серверу

| | Минимум | Рекомендуется |
| :--- | :--- | :--- |
| ОС | Linux x86_64 (Ubuntu 22.04+/RHEL 9+); для проверки — Windows/macOS с Docker Desktop | — |
| Docker | Docker Engine 24+ и Compose v2.24+ (`docker compose version`) | последние стабильные |
| CPU / RAM | 4 vCPU / 8 ГБ (внешний LLM-провайдер) | 8 vCPU / 16 ГБ; профиль `offline` — от 32 ГБ |
| Диск | 30 ГБ (образы, данные, логи) | SSD 100 ГБ+; модели Ollama — ещё 5–50 ГБ |
| GPU (профиль `gpu`) | NVIDIA с драйвером + nvidia-container-toolkit | VRAM под выбранную модель |
| Сеть | интернет на время сборки; во время работы — только до LLM-провайдера (или вовсе без сети в `offline`) | — |

Наружу стек публикует только два порта и только на `BIND_ADDR` (по умолчанию `127.0.0.1`): веб `WEB_PORT` (8080)
и Grafana `GRAFANA_PORT` (3000, профиль `monitoring`). Postgres, Redis, Qdrant, SeaweedFS, Prometheus, Loki доступны
только внутри docker-сети `backend`. TLS, домен и обратный прокси настраиваются на хосте (nginx — пример по ссылке
выше: без буферизации и с таймаутом 1 ч для SSE на `/api/`, `client_max_body_size`).

## Первый запуск

В `.env` только ключи, пароли и логины. Всё про ИИ (провайдеры, API-ключи, модели, эмбеддинги) задаётся после
запуска в веб-интерфейсе: «Кабинет» → «Провайдеры» и «Параметры».

Linux:

```bash
git clone <репозиторий> reqcheck && cd reqcheck
```

```bash
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/work" -w /work alpine:3 sh deploy/secrets/generate.sh
```

Windows (PowerShell, Docker Desktop):

```powershell
docker run --rm -v "${PWD}:/work" -w /work alpine:3 sh deploy/secrets/generate.sh
```

Генератор создаёт `.env` из `.env.example` и заполняет пустые секреты случайными значениями; повторный запуск
безопасен — непустые значения он не меняет. Альтернатива для ключей приложения:
`docker compose run --rm --no-deps api python -m app.keygen` печатает `APP_ENCRYPTION_KEY` и `APP_SECRET_KEY`
(остальные пароли тогда заполните сами).

При необходимости раскомментируйте в конце `.env` блок «Необязательно при установке»: `BIND_ADDR`, `WEB_PORT`,
`GRAFANA_PORT`, `COMPOSE_PROFILES=monitoring`. Затем:

```bash
docker compose up -d --build
```

```bash
docker compose ps
```

```bash
docker compose --profile test run --rm --build test-infra
```

Последняя команда — смоук-тест хранилищ (Postgres, Redis, Qdrant, запись и чтение объекта в S3).

Войдите в веб (`http://<BIND_ADDR>:<WEB_PORT>`) под `ADMIN_USERNAME` / `ADMIN_PASSWORD` из `.env` и подключите
LLM-провайдера в «Кабинете». Админ создаётся при первом старте, потом пароль меняется в кабинете. Пароли Postgres
и ключи S3 применяются при **первой** инициализации томов; как сменить их потом —
[configuration.md](configuration.md#смена-секретов-после-установки). Не меняйте `APP_ENCRYPTION_KEY` после ввода
ключей провайдеров — их придётся ввести заново.

## Профили

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
| `mock` | `web-mock` — веб на моках без бэкенда (порт `WEB_MOCK_PORT`, 8081) |

`offline` и `gpu` взаимоисключающие: оба сервиса отвечают по имени `ollama`, включайте один.

## Обновление и миграции

```bash
git pull
```

```bash
docker compose --profile backup run --rm backup
```

```bash
docker compose up -d --build
```

Сначала бэкап, затем пересборка; сервис `migrate` выполняет `alembic upgrade head` при каждом `up` и запускает
`api`/`worker` только после успешной миграции. Версии образов инфраструктуры закреплены в `compose.yaml`; при смене
**мажорной** версии Postgres нужен дамп и восстановление (см. «Бэкапы»), а не просто смена тега.

Старые образы не удаляются автоматически. Не запускайте `docker image prune` или `docker system prune` на сервере,
где работают чужие контейнеры: эти команды затрагивают весь Docker. Удаляйте только образы ReqCheck по имени.

## Офлайн-установка (локальная LLM)

1. В `.env`: `COMPOSE_PROFILES=monitoring,offline` и модели для вшивания в образ, например `OLLAMA_MODELS=qwen3:8b`
   (через запятую можно несколько; см. [configuration.md](configuration.md)).
2. `docker compose up -d --build` **на машине с интернетом**: модели скачиваются при сборке и лежат внутри образа
   `reqcheck-ollama:local`, модель эмбеддингов — внутри образа `embedder`.
3. В веб-интерфейсе, «Кабинет» → «Провайдеры»: «Локальная модель (OpenAI API)» (`openai_compatible`), адрес `http://ollama:11434/v1`,
   модель из `OLLAMA_MODELS`; эмбеддинги — локальные.
4. Дальше сервер работает без интернета. Перенос на изолированный сервер без сборки — через
   `docker save`/`docker load` (готовый комплект — в бэклоге).

Сменили список моделей — пересоберите: `docker compose build ollama && docker compose up -d ollama`.
Память контейнера ограничена `OLLAMA_MEM_LIMIT` (по умолчанию 16g) — модель должна в неё помещаться.

## GPU (NVIDIA)

На хосте нужны драйвер NVIDIA и
[nvidia-container-toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html):

```bash
sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker
```

```bash
docker run --rm --gpus all ubuntu nvidia-smi
```

Затем — те же шаги, что для офлайна, но `COMPOSE_PROFILES=monitoring,gpu`. Сервис `ollama-gpu` резервирует все GPU
(`deploy.resources.reservations.devices`) и доступен по адресу `http://ollama:11434`.
Проверка: `docker compose exec ollama-gpu ollama ps` — в колонке PROCESSOR должно быть `100% GPU`.

## Мониторинг

Профиль `monitoring` включается строкой `COMPOSE_PROFILES=monitoring` в `.env`. Grafana:
`http://<BIND_ADDR>:<GRAFANA_PORT>`, логин `GRAFANA_ADMIN_USER`/`GRAFANA_ADMIN_PASSWORD`, домашний дашборд —
«ReqCheck» (API, прогоны, очередь Celery, токены LLM, ресурсы, логи). Логи всех контейнеров — в Loki
(Grafana → Explore). Хранение: `PROMETHEUS_RETENTION` (15d), `LOKI_RETENTION` (14 дней). Логи Docker ротируются
(5 файлов по 10 МБ на контейнер). Подробно — [monitoring.md](monitoring.md).

## Бэкапы

```bash
docker compose --profile backup run --rm backup
```

```bash
docker compose --profile backup run --rm backup list
```

Бэкап кладётся в `./backups/<UTC-время>/`: дамп Postgres (`postgres.dump`), снапшоты коллекций Qdrant
(`qdrant/*.snapshot`), копия бакета S3 (`s3/`) и `manifest.json`. Redis не бэкапится (очередь и кеш). Каталоги
старше `BACKUP_KEEP_DAYS` удаляются. Расписание — cron на хосте, например ежедневно в 03:00:

```cron
0 3 * * * cd /opt/reqcheck && docker compose --profile backup run --rm -T backup >> backups/backup.log 2>&1
```

Копируйте `./backups` на другой сервер/хранилище — бэкап на том же диске не спасёт от его потери.

**Восстановление** (перезаписывает текущие данные):

```bash
docker compose stop web api worker
```

```bash
docker compose --profile backup run --rm backup restore 20261127T030000Z --yes
```

```bash
docker compose up -d
```

Восстановление на новый сервер: развернуть стек с тем же `.env`, скопировать каталог бэкапа в `./backups/`,
выполнить команды выше.

## Полезные команды

| Команда | Что делает |
| :--- | :--- |
| `docker compose ps` | состояние и healthcheck |
| `docker compose logs -f api worker` | логи |
| `docker compose down` | остановить; данные в томах сохраняются |
| `docker compose down -v` | остановить и **удалить все данные** ReqCheck (только тома этого проекта) |
