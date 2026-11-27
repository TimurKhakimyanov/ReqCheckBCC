# ReqCheck — агент проверки требований

ИИ-агент статической проверки документа с требованиями по ISO/IEC/IEEE 29148:2018 (п. 5.2.5, 5.2.6)
и IEEE Std 830-1998 (п. 4.3). Выделяет требования, проверяет каждое и набор целиком, пишет отчёт на русском.
Есть CLI (одна команда) и веб-интерфейс со стеком для развёртывания у себя.

- Постановка: [docs/task.md](docs/task.md)
- Архитектура: [docs/architecture.md](docs/architecture.md), HTTP API: [docs/api.md](docs/api.md)
- Бэклог: [BACKLOG.md](BACKLOG.md)

<!-- ===================== Раздел сессии «Ядро» ===================== -->
## Быстрый прогон агента (CLI)

### Одной командой, как в bbc-agent: `python run.py`

```powershell
python -m venv .venv
```

```powershell
.venv\Scripts\pip install -e packages/contracts -e packages/core
```

```powershell
.venv\Scripts\python run.py samples/requirements.md reports/report.pdf
```

Настройки модели — те же переменные, что в bbc-agent, в файле `.env` текущей папки или в файле из `--env`.
Можно взять готовый `.env` от bbc-agent: `--env путь\к\bbc-agent\.env`. Флаги важнее переменных, уже заданные
переменные окружения важнее файла.

| Переменная | Что задаёт |
| :--- | :--- |
| `LLM_PROVIDER` | `gemini`, `openai` (с `OPENAI_BASE_URL` не на api.openai.com — любой OpenAI-совместимый сервер: vLLM, LM Studio), `ollama`, `anthropic` |
| `OPENAI_BASE_URL`, `OPENAI_MODEL`, `OPENAI_API_KEY` | OpenAI-совместимый сервер, модель и ключ (для vLLM без авторизации ключ не нужен) |
| `GEMINI_API_KEY`, `GEMINI_MODEL` · `OLLAMA_BASE_URL`, `OLLAMA_MODEL` | Gemini · Ollama |
| `LLM_CONCURRENCY` | параллельных вызовов: локальный сервер — 8, бесплатный Gemini — 1 |
| `AGENT_BATCH_SIZE` | требований на один вызов инспектора (5) |
| `LLM_MAX_TOKENS`, `LLM_TIMEOUT`, `LLM_MIN_INTERVAL`, `LLM_MAX_RETRIES`, `LLM_TEMPERATURE` | лимит ответа, таймаут вызова (600 с), пауза между вызовами, повторы при 429/5xx, температура (0) |
| `LLM_CONTEXT_TOKENS` | окно модели; по умолчанию его сообщает сервер (vLLM — `max_model_len`) |
| `LLM_EXTRA_BODY`, `LLM_EXTRA_BODY_REVIEWER` | доп. параметры запроса для всех ролей и для рецензентов набора (JSON) |
| `LLM_CACHE_DIR` | кэш ответов модели (`.cache/llm`): повторный прогон того же документа с теми же настройками — за секунды |

Своя модель или лимит на отдельную роль (`MODEL_<РОЛЬ>`, `LLM_MAX_TOKENS_<РОЛЬ>`) и `LLM_TRUNCATION_FALLBACK_BODY`
в Zoe не поддерживаются — агент предупредит, если они заданы.

Ключи как в bbc-agent:

| Ключ | Что делает |
| :--- | :--- |
| `--ask` | задать уточняющие вопросы в консоли (номер варианта или свой текст; Enter — пропустить, `q` — закончить) и учесть ответы в этом же отчёте |
| `--answers FILE` | ответы файлом: впишите их в поле `answer` файла `<отчёт>.questions.json` прошлого прогона |
| `--max-questions N` | максимум вопросов: от 1 до 6 (5) |
| `--no-cache` | не использовать кэш ответов модели |
| `--env FILE` | файл с переменными (по умолчанию `.env`, если есть) |
| `--quiet`, `--version` | без хода работы; версия агента |

```powershell
.venv\Scripts\python run.py doc.pdf reports/report.md --ask
```

```powershell
.venv\Scripts\python run.py doc.pdf reports/report.md --answers reports/report.questions.json
```

Рядом с отчётом создаются `report.pdf` и `report.questions.json` (вопросы автору — для `--answers`).
Остальные флаги — ниже и в `python run.py --help`. То же самое без Python — в Docker:

### В Docker

Агент принимает путь к документу требований (PDF, DOCX, MD, TXT) и путь к файлу отчёта. Нужен только Docker.

**1. Ключ LLM.** Бесплатный ключ Gemini: [aistudio.google.com](https://aistudio.google.com/) → *Get API key* →
*Create API key*. Для бесплатного тарифа достаточно. Для локальной модели (vLLM, Ollama) ключ не нужен.

**2. Куда положить.** Никуда: ключ передаётся при запуске — переменной окружения (`-e GEMINI_API_KEY=...`)
или флагом `--api-key`. В Docker файл `.env` для LLM не используется (в нём только пароли инфраструктуры; он нужен
docker compose, поэтому один раз выполните `Copy-Item .env.example .env`); `python run.py` читает переменные
bbc-agent (см. выше). В веб-интерфейсе ключи и параметры ИИ задаются в админке.

**3. Запуск одной командой.** Положите документ в каталог `data/` и выполните:

```powershell
docker compose -p reqcheck-core --profile cli run --rm --build -e GEMINI_API_KEY=ваш-ключ cli /data/requirements.pdf /data/report.pdf
```

Другие провайдеры:

```powershell
docker compose -p reqcheck-core --profile cli run --rm -e ANTHROPIC_API_KEY=ваш-ключ cli /data/requirements.pdf /data/report.pdf --provider anthropic --model claude-opus-5-5
```

Локальная модель на vLLM / Ollama (ключ не нужен). Для моделей с рассуждениями рассуждения выключаются на
проверке требований и включаются на поиске противоречий в наборе (`--extra-body`, `--extra-body-set-review`);
с рассуждениями один запрос проверки набора идёт несколько минут, поэтому `--timeout 900`. На примере из
`samples/` (42 требования) прогон на `mimo-v2.6-flash` занимает около 8 минут:

```powershell
docker compose -p reqcheck-core --profile cli run --rm cli /data/requirements.md /data/report.pdf --provider openai_compatible --base-url http://vllm.example.local:8000/v1 --model mimo-v2.6-flash --concurrency 4 --max-tokens 48000 --timeout 900 --extra-body '{\"chat_template_kwargs\":{\"enable_thinking\":false}}' --extra-body-set-review '{\"chat_template_kwargs\":{\"enable_thinking\":true}}'
```

(`OPENAI_API_KEY` + `--provider openai` — аналогично.)

**4. Модель.** `--model <id>`. Если не указана — агент берёт первую доступную ключу модель из списка
рекомендованных (Gemini: `gemini-4-hydrogen` → `gemini-3.8-flash` → …; Anthropic: `claude-opus-5-5` → …).
Фактическая модель всегда записывается в паспорт отчёта. Temperature 0 (где модель её принимает),
структурированный JSON-вывод: нативная JSON Schema провайдера → инструмент → схема в промпте с проверкой.

**5. Отчёт** — итоговый **`data/report.pdf`**. Формат определяется по расширению (`.pdf`, `.md`, `.json`, `.docx`;
без расширения — PDF); если основной файл не PDF, рядом всё равно создаётся `report.pdf` (отключить — `--no-pdf`).
Ещё форматы — `--also md,json,docx`. Прогресс выводится в терминал.

Флаги: `--provider gemini|openai|anthropic|openai_compatible`, `--model`, `--api-key`, `--base-url`,
`--no-verify` (без верификатора — по умолчанию он опровергает каждый дефект и сливает дубли), `--no-questions` (без уточняющих вопросов автору), `--max-questions`, `--no-split` (не выделять подтребования),
`--min-interval` (пауза между запросами, с), `--max-attempts` (повторы при 429/5xx), `--max-output-tokens`,
`--batch-size`, `--concurrency`, `--help`. Если бесплатный Gemini отвечает `429`, агент сам ждёт и повторяет
запрос; при частых ограничениях добавьте `--min-interval 6`.

Версия агента в паспорте отчёта — коммит или тег: при запуске из клона — `git describe`, в Docker — коммит,
который образ при сборке сам читает из каталога `.git` (git в образе не нужен). Переменная `AGENT_VERSION`
задаёт версию явно — она нужна только при сборке из архива без `.git` или из рабочей копии `git worktree`:

```powershell
$env:AGENT_VERSION = git describe --always --dirty; docker compose -p reqcheck-core --profile cli run --rm --build -e GEMINI_API_KEY=ваш-ключ cli /data/requirements.pdf /data/report.pdf
```

### Как агент проверяет

Ядро — агенты из bbc-agent (`packages/core/req_core/agent`): каждый агент читает и пишет общий граф памяти
(требования, критерии, подсказки, замечания, вопросы), отчёт собирается обходом графа. Методика агентов — в
промтах `req_core/agent/prompts/*.md` (версионируются, версии попадают в отчёт).

1. **Чтение**: PDF (текст, таблицы, заголовки по размеру шрифта, номера страниц), DOCX (включая таблицы),
   MD, TXT → нормализованный текст, нарезанный на пронумерованные строки `L<n>|`; каждое место в отчёте — строки
   документа и точные смещения символов.
2. **Правила без LLM** — подсказки агентам, а не готовые дефекты: размытые слова, заглушки и прочерки, GET для
   записи, неописанные коды ответов, тиыны и тенге, «сразу» против «в течение минуты», время у границы суток;
   плюс проверки ReqCheck (незаполненные разделы и поля шаблона, версия документа). Модель подтверждает подсказку
   замечанием или отбрасывает её.
3. **Нарезчик** в два прохода: модель выделяет требования, затем **контроль покрытия** — строки, не вошедшие ни в
   одно требование, отдаются модели повторно (пропущенное требование или «не требование» с причиной). Кандидаты
   правил (`Ф-N`, строки критериев приёмки, параметры API), которые модель не взяла и не объяснила, добавляются.
4. **Планировщик и воркеры**: матрица «требование × критерий» (9 критериев п. 5.2.5) — инспектор ставит каждой
   клетке ok / violation / na; шесть рецензентов набора (контролёр логики правил, контролёр согласованности
   спецификаций, системный аналитик, тест-аналитик, архитектор интеграций, аналитик рисков и ИБ) параллельно.
   Непокрытое уходит в следующий раунд пачками вдвое меньше (до 4 раундов) — модель не может «тихо» пропустить
   требования. Большой документ делится на части под окно модели (`ProviderConfig.context_tokens`).
5. **Контроль достоверности кодом**: замечание без цитаты, найденной в документе, не принимается; цитаты в
   «ёлочках» внутри объяснения сверяются с документом; ссылки на несуществующие требования, замечания и вопросы
   вычищаются; у каждого замечания — уровень привязки (дословно / с искажением / по строке).
6. **Верификатор**: модель-оппонент пытается опровергнуть каждое замечание и выравнивает критичность. Затем
   сливаются дубли от разных агентов: сначала код объединяет явные повторы (то же место документа и та же
   формулировка), потом модель в два прохода предлагает группы, а код решает, что объединять. Если модель на этом
   шаге не ответила (например, потратила лимит ответа на рассуждения), запрос повторяется с большим лимитом, а при
   неудаче остаётся слияние кодом и в отчёт попадает предупреждение. Серьёзность слитого замечания — медиана оценок
   по всем его повторам. Отключается флагом `--no-verify`.
7. **Аналитик уточнений**: закрытые вопросы автору с вариантами ответа; параллельно — чек-лист «Ревью требований»
   (если есть в документе). Ответы автора (`--answers`, `ValidationOptions.answers`) превращаются в новые редакции
   требований и снятые дефекты.
8. **Итог руководителя ревью**: нельзя / можно с ограничениями / можно, что брать в разработку и тестирование
   сейчас, что исправить первым (с обоснованием), сильные стороны документа. Предохранители кодом: при критичных
   дефектах «можно» не бывает; если модель проверила не все требования — тоже; числа в тексте итога сверяются со
   статистикой прогона.
9. **Отчёт**: проверка каждого требования — сводная матрица «требование × критерий» и разбор по требованиям
   (нарушенные критерии с замечаниями, остальные одной строкой); в приложении — текст документа с номерами строк,
   на которые ссылаются замечания.

Замер полноты на примере: `packages/core/eval/recall.py` + эталон `packages/core/eval/requirements_md_reference.json`
(эталон в промптах не используется).

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

В `.env` только ключи, пароли и логины. Всё про ИИ (провайдеры, API-ключи, модели, эмбеддинги) задаётся
после запуска в веб-интерфейсе, в разделе «Администрирование». Полный список настроек —
[docs/configuration.md](docs/configuration.md).

```bash
git clone <репозиторий> reqcheck && cd reqcheck
# создать .env из .env.example и заполнить пустые секреты случайными значениями (только в Docker):
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/work" -w /work alpine:3 sh deploy/secrets/generate.sh
```

При необходимости раскомментируйте в конце `.env` блок «Необязательно при установке»: `BIND_ADDR`, `WEB_PORT`,
`GRAFANA_PORT`, `COMPOSE_PROFILES=monitoring` (мониторинг). Затем:

```bash
docker compose up -d --build
docker compose ps                     # все сервисы healthy / running
docker compose --profile test run --rm --build test-infra   # смоук-тест хранилищ
```

Войдите в веб (`http://<BIND_ADDR>:<WEB_PORT>`) под `ADMIN_USERNAME` / `ADMIN_PASSWORD` из `.env` и в
«Администрировании» добавьте ключ LLM-провайдера. Пароли Postgres и ключи S3 применяются при **первой**
инициализации томов; как сменить их потом — [docs/configuration.md](docs/configuration.md#смена-секретов-после-установки).

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

1. В `.env`: `COMPOSE_PROFILES=monitoring,offline` и модели для вшивания в образ, например
   `OLLAMA_MODELS=qwen3:8b` (через запятую можно несколько; см. [docs/configuration.md](docs/configuration.md)).
2. `docker compose up -d --build` **на машине с интернетом**: модели скачиваются при сборке и лежат внутри
   образа `reqcheck-ollama:local`, модель эмбеддингов — внутри образа `embedder`.
3. В веб-интерфейсе, «Администрирование»: провайдер `openai_compatible`, адрес `http://ollama:11434/v1`,
   модель из `OLLAMA_MODELS`, эмбеддинги — локальные.
4. Дальше сервер работает без интернета. Перенос на изолированный сервер без сборки — через
   `docker save`/`docker load` (готовый комплект — в бэклоге).

Сменили список моделей — пересоберите: `docker compose build ollama && docker compose up -d ollama`.
Память контейнера ограничена `OLLAMA_MEM_LIMIT` (по умолчанию 16g) — модель должна в неё помещаться.

### GPU (NVIDIA)

На хосте нужны драйвер NVIDIA и [nvidia-container-toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html):

```bash
sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker
docker run --rm --gpus all ubuntu nvidia-smi      # проверка: видна видеокарта
```

Затем — те же шаги, что для офлайна, но `COMPOSE_PROFILES=monitoring,gpu`. Сервис `ollama-gpu`
резервирует все GPU (`deploy.resources.reservations.devices`) и доступен по адресу `http://ollama:11434`.
Проверка: `docker compose exec ollama-gpu ollama ps` — в колонке PROCESSOR должно быть `100% GPU`.

### Мониторинг

Профиль `monitoring` включается строкой `COMPOSE_PROFILES=monitoring` в `.env`. Grafana: `http://<BIND_ADDR>:<GRAFANA_PORT>`,
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
Всё про ИИ задаётся только в кабинете, а не в `.env`: ключи и адреса провайдеров (`/api/providers`, ключи хранятся
в Postgres зашифрованными — Fernet, `APP_ENCRYPTION_KEY`), провайдер и модель по умолчанию, таймаут прогона, пауза и
число попыток LLM, размер пакета и параллельность, эмбеддинги (`/api/settings`). Локальный OpenAI-совместимый сервер
(vLLM, Ollama) подключается указанием адреса, ключ не нужен. Кнопка «Проверить» в форме провайдера сразу возвращает
список моделей — до сохранения.
Не меняйте `APP_ENCRYPTION_KEY` после ввода ключей — их придётся ввести заново.

**Прогон и прогресс.** `POST /api/runs` ставит задачу в очередь Redis; воркер публикует события в канал `run:{id}:events`,
api отдаёт их по SSE (`GET /api/runs/{id}/events`, сначала текущее состояние). Отмена — флаг в Redis: ядро прерывается
на ближайшем событии прогресса. Прогон дольше `run_timeout_s` (настройки) завершается ошибкой. Ошибки провайдера (неверный ключ,
лимит 429, таймаут) пишутся в `runs.error` понятным текстом.

**Поиск и база знаний.** Qdrant: коллекция `knowledge` (при первом старте туда индексируется пересказ критериев
29148/830; загруженные PDF/DOCX/MD/TXT и заметки режутся на фрагменты) и `requirements` (требования и дефекты прошлых
прогонов). Фрагменты базы знаний подмешиваются в прогон (`ValidationOptions.knowledge_snippets`) и в чат.
Эмбеддинги: по умолчанию локальная модель внутри `embedder` (вшивается при сборке, аргумент `EMBEDDINGS_MODEL`);
в настройках можно выбрать Gemini или OpenAI — api передаёт ключ в каждом запросе к embedder. После смены модели
коллекции пересоздаются, база знаний и отчёты индексируются заново в фоне.

**Наблюдаемость.** Логи — JSON в stdout (одна строка на событие, поля `service`, `run_id`, `route`, `duration_ms`).
Метрики Prometheus: `api:8000/metrics`, `worker:9101/metrics`, `embedder:8001/metrics` (только внутренняя сеть).
`GET /api/health` проверяет Postgres, Redis, Qdrant, S3 и embedder.

**Тесты** — в общем разделе ниже (`test-api`, `test-worker`, `test-embedder`): Postgres и Redis настоящие, S3 и Qdrant —
в памяти, ядро — мок на `sample_report.json`.

Уточнения контракта с вебом, ядром и инфраструктурой — [docs/contract-changes/backend.md](docs/contract-changes/backend.md).

<!-- ===================== Раздел сессии «Веб» ===================== -->
## Веб-интерфейс

React + TypeScript + Vite, Tailwind + shadcn/ui, TanStack Query, i18next. Код — `services/web`.
Открывается на `http://localhost:${WEB_PORT}` (по умолчанию 8080), вход — `ADMIN_USERNAME` / `ADMIN_PASSWORD` из `.env`.

**Показать интерфейс без бэкенда** (все методы API имитируются MSW по `sample_report.json`, прогресс и чат — потоком):

```bash
docker compose --profile mock up -d --build web-mock   # http://localhost:8081, логин admin / admin
```

Порт меняется переменной `WEB_MOCK_PORT`. В демо-режиме прогон документа с `fail` в имени файла завершается ошибкой —
чтобы показать экран сбоя.

Что есть: вход; документы (drag & drop PDF/DOCX/MD/TXT, история прогонов); запуск прогона (провайдер, модель, опции);
прогресс по SSE; отчёт — текст документа с подсветкой цитат ↔ список дефектов, фильтры, решения по дефектам
(принят / ложное срабатывание / исправлен + комментарий), вкладки «Сводка и итог», «Нарезка», «Матрица», «Проверка набора»,
«Чек-лист», «Паспорт», выгрузка PDF/DOCX/MD/JSON; чат по отчёту; поиск по прошлым прогонам; база знаний; кабинет
(ключи провайдеров, проверка подключения, модель по умолчанию, язык, тема, пароль); расход токенов; журнал аудита.

- **Языки**: файл на язык в `services/web/src/locales/` (`ru.json`, `en.json`, черновик `kk.json`). Новый язык — новый файл,
  он появится в переключателе сам. Недостающие казахские строки показываются по-русски.
- **Тема и стиль**: все цвета, радиусы, тени и шрифты — CSS-переменные в `services/web/src/index.css` (светлая и тёмная).
  Визуальный язык: тёмный фон с точками `.bg-dots` (тёмная тема по умолчанию), тонкие рамки вместо теней, прямые углы,
  моноширинные метки `.label-mono` с цветным квадратиком, оранжевый акцент `--primary` для «агент работает», бирюзовый
  `--teal` для «готово». Экран прогона — изометрический конвейер агентов (`features/runs/AgentScene.tsx`, стили `.rc-scene`,
  `.rc-st`, `.rc-layer` в `index.css`); вкладка «Сводка и итог» — статистика отчёта (`features/report/SummaryTab.tsx`).
  Шрифты Geist и Geist Mono (OFL) встроены в сборку — работают без интернета. Перекраска — правка токенов, компоненты не трогаются.
- **Типы отчёта** генерируются из JSON Schema контракта и лежат в git (`src/api/report.gen.ts`); тест падает, если они устарели.
  Перегенерировать после изменения контракта (в контейнере, на хосте ничего не ставится):
  `docker run --rm -v "$PWD:/repo" -w /repo/services/web node:22-alpine sh -c "corepack enable && pnpm install --frozen-lockfile && pnpm gen:types && rm -rf node_modules"`.
- **Корпоративный прокси с подменой TLS**: если сборка падает на `unable to verify the first certificate`, положите корневой
  сертификат в `services/web/certs/*.crt` (в git не попадает, см. `services/web/certs/README.md`).
- Пожелания веба к API: [docs/contract-changes/web.md](docs/contract-changes/web.md).

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
