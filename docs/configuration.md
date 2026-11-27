# Конфигурация ReqCheck

Три уровня настроек:

1. **`.env` — только то, что задаётся один раз при установке**: ключи, пароли, логины ([.env.example](../.env.example)).
2. **Веб-интерфейс, «Администрирование»** — всё про ИИ: провайдеры и их API-ключи (хранятся в Postgres,
   зашифрованы `APP_ENCRYPTION_KEY`), модели, эмбеддинги, паузы и размер пакетов запросов, локальная модель
   (`openai_compatible`, адрес `http://ollama:11434/v1`). Менять `.env` и перезапускать стек для этого не нужно.
3. **Расширенные переопределения** — переменные со значениями по умолчанию в `compose.yaml`
   (`${VAR:-default}`). Обычно их не трогают; чтобы изменить, допишите строку `VAR=значение` в `.env`
   и выполните `docker compose up -d`.

## Секреты и логины (`.env`)

| Переменная | Что это | По умолчанию |
| :--- | :--- | :--- |
| `APP_SECRET_KEY` | подпись сессий входа | генерируется |
| `APP_ENCRYPTION_KEY` | ключ Fernet, шифрует API-ключи провайдеров в БД | генерируется |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | администратор веб-интерфейса | `admin` / генерируется |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` | учётная запись Postgres | `reqcheck` / генерируется |
| `REDIS_PASSWORD` | пароль Redis | генерируется |
| `QDRANT_API_KEY` | API-ключ Qdrant | генерируется |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | ключи S3 (SeaweedFS) | `reqcheck` / генерируется |
| `GRAFANA_ADMIN_USER` / `GRAFANA_ADMIN_PASSWORD` | вход в Grafana (профиль `monitoring`) | `admin` / генерируется |

Генератор — только в Docker, из корня репозитория; создаёт `.env` из `.env.example`, если его нет,
и заполняет **только пустые** значения (и `change-me`), поэтому повторный запуск безопасен:

```bash
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/work" -w /work alpine:3 sh deploy/secrets/generate.sh
```

Пока секрет пуст, `docker compose` не стартует и пишет, какой переменной не хватает.

### Смена секретов после установки

| Что | Как |
| :--- | :--- |
| `POSTGRES_PASSWORD` | пароль хранится в томе БД: `docker compose exec postgres psql -U <POSTGRES_USER> -d reqcheck -c "ALTER USER <POSTGRES_USER> PASSWORD '<новый>'"`, затем новый пароль в `.env` и `docker compose up -d` |
| `REDIS_PASSWORD`, `QDRANT_API_KEY`, `S3_ACCESS_KEY`/`S3_SECRET_KEY` | поменять в `.env`, `docker compose up -d` (берутся из окружения при старте) |
| `GRAFANA_ADMIN_PASSWORD` | после первого старта хранится в БД Grafana: `docker compose exec grafana grafana cli admin reset-admin-password <новый>` |
| `APP_SECRET_KEY` | поменять в `.env`, `docker compose up -d` — все пользователи будут разлогинены |
| `APP_ENCRYPTION_KEY` | сохранённые API-ключи провайдеров станут нечитаемыми — после смены заново введите их в «Администрировании» |
| `ADMIN_PASSWORD` | см. раздел бэкенда в README (создаётся при первом запуске) |

## Необязательно при установке

Закомментированы в конце `.env.example`; раскомментируйте, если нужно.

| Переменная | По умолчанию | Что это |
| :--- | :--- | :--- |
| `BIND_ADDR` | `127.0.0.1` | адрес хоста, на котором публикуются веб и Grafana. `0.0.0.0` — только если перед стеком нет своего прокси |
| `WEB_PORT` | `8080` | порт веба на хосте |
| `GRAFANA_PORT` | `3000` | порт Grafana на хосте |
| `COMPOSE_PROFILES` | — (только основной стек) | профили через запятую: `monitoring`, `offline` **или** `gpu` |

## Расширенные переопределения (инфраструктура)

Значения по умолчанию — в инфраструктурных разделах `compose.yaml`.

| Переменная | По умолчанию | Где действует | Что это |
| :--- | :--- | :--- | :--- |
| `POSTGRES_DB` | `reqcheck` | postgres, приложение, экспортер, бэкап | имя базы. Менять только до первого запуска |
| `S3_BUCKET` | `reqcheck` | seaweedfs, приложение, бэкап | бакет для файлов и выгрузок, создаётся автоматически |
| `SEAWEEDFS_VOLUME_SIZE_MB` | `1024` | seaweedfs | размер одного тома SeaweedFS |
| `GRAFANA_ROOT_URL` | пусто | grafana | внешний адрес Grafana за прокси, например `https://reqcheck.example.kz/grafana/` |
| `GRAFANA_SERVE_FROM_SUB_PATH` | `false` | grafana | `true`, если прокси отдаёт Grafana по подпути (`/grafana/`) |
| `PROMETHEUS_RETENTION` | `15d` | prometheus | срок хранения метрик |
| `PROMETHEUS_RETENTION_SIZE` | `5GB` | prometheus | предельный объём метрик на диске |
| `LOKI_RETENTION` | `336h` | loki | срок хранения логов (14 дней) |
| `BACKUP_KEEP_DAYS` | `14` | backup | сколько дней хранить каталоги в `./backups` (`0` — не удалять) |
| `OLLAMA_MODELS` | пусто | ollama / ollama-gpu (сборка) | модели, вшиваемые в образ при сборке, через запятую, например `qwen3:8b` |
| `OLLAMA_MEM_LIMIT` | `16g` | ollama / ollama-gpu | лимит памяти контейнера (модель должна помещаться) |
| `OLLAMA_KEEP_ALIVE` | `30m` | ollama / ollama-gpu | сколько держать модель загруженной после запроса |
| `OLLAMA_NUM_PARALLEL` | `2` | ollama / ollama-gpu | параллельных запросов к модели |
| `APP_ENV` | `production` | приложение | окружение |
| `LOG_LEVEL` | `INFO` | приложение | уровень логов |
| `AGENT_VERSION` | `dev` | сборка образов | версия агента в отчётах; без неё образ берёт коммит из `.git` при сборке |
| `COMPOSE_PROJECT_NAME` | `reqcheck` | весь стек | имя проекта; от него зависят имена томов. Alloy собирает логи только этого проекта, Prometheus — метрики контейнеров проектов `reqcheck*` |

Лимиты CPU и памяти сервисов, версии образов и прочее, чего нет в таблице, меняются через
`compose.override.yaml` рядом с `compose.yaml` (Compose подхватывает его автоматически), например:

```yaml
services:
  qdrant:
    deploy:
      resources:
        limits: { cpus: "4", memory: 4g }
```

Переменные окружения сервисов приложения (`api`, `worker`, `embedder`, `web`) описывают их владельцы — см.
разделы бэкенда и веба в README.
