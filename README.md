# Zoe (ReqCheck) — ИИ-агент проверки требований

**Zoe** — ИИ-агент статической проверки документа с требованиями (ТЗ) по ISO/IEC/IEEE 29148:2018 (п. 5.2.5, 5.2.6)
и IEEE Std 830-1998 (п. 4.3). ReqCheck — кодовое имя проекта и репозитория; в интерфейсе и отчётах продукт
называется Zoe. Решение задачи хакатона BCC-HUB × MNU ([docs/task.md](docs/task.md)).

**На входе** — документ требований (PDF, DOCX, MD, TXT). **На выходе** — отчёт на русском (PDF; по желанию ещё MD,
JSON, DOCX): выделенные требования, матрица «требование × 9 критериев 29148», замечания с цитатами и номерами строк,
противоречия и пробелы в наборе, уточняющие вопросы автору, итог «можно ли брать в разработку» и паспорт прогона
(модель, версия агента, токены).

Работает двумя способами: **CLI** — одна команда «файл требований → файл отчёта», и **веб-интерфейс** со стеком для
развёртывания у себя.

**Содержание:** [Быстрый старт](#быстрый-старт) · [Ключ LLM](#ключ-llm-где-взять-и-куда-положить) · [CLI](#cli) ·
[Веб-интерфейс](#веб-интерфейс-и-стек) · [Как устроен агент](#как-устроен-агент) ·
[Развёртывание](#развёртывание) · [Решение проблем](#решение-проблем) · [Тесты](#тесты) ·
[Структура репозитория](#структура-репозитория)

## Быстрый старт

Нужны только Docker (на Windows — Docker Desktop) и ключ LLM. Бесплатный ключ Gemini:
[aistudio.google.com](https://aistudio.google.com/) → *Get API key* → *Create API key*.

Прогоняем документ организаторов хакатона — [samples/requirements.md](samples/requirements.md) (это выданный файл
без изменений). Все команды — из корня репозитория.

**Windows (PowerShell):**

1. Создать `.env` с секретами установки — без него `docker compose` не стартует (ключ LLM туда не пишется):

```powershell
docker run --rm -v "${PWD}:/work" -w /work alpine:3 sh deploy/secrets/generate.sh
```

2. Создать папку `data` и положить в неё документ:

```powershell
New-Item -ItemType Directory -Force data
```

```powershell
Copy-Item samples/requirements.md data/
```

3. Прогон — путь к файлу требований → путь к файлу отчёта (в контейнере `./data` видна как `/data`):

```powershell
docker compose -p reqcheck-core --profile cli run --rm --build -e GEMINI_API_KEY=ваш-ключ cli /data/requirements.md /data/report.pdf
```

**Linux / macOS (bash):**

```bash
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/work" -w /work alpine:3 sh deploy/secrets/generate.sh
```

```bash
mkdir -p data && cp samples/requirements.md data/
```

```bash
docker compose -p reqcheck-core --profile cli run --rm --build -e GEMINI_API_KEY=ваш-ключ cli /data/requirements.md /data/report.pdf
```

**Результат:** отчёт **`data/report.pdf`**, рядом — `data/report.questions.json` (вопросы автору, если есть). Ход
работы печатается в терминал; в конце — число требований (на этом документе — около 50), замечаний, вопросов и
итог. Время зависит от модели и тарифа: от нескольких минут до десятков минут на бесплатном Gemini. Первый запуск
дольше — собирается образ.

Своего документа достаточно положить в `data/` и подставить его имя. Секретов в репозитории нет: `.env` создаётся
у вас и в git не попадает, шаблон — [.env.example](.env.example).

## Ключ LLM: где взять и куда положить

| Провайдер | Где взять ключ | CLI: флаг / переменная | Веб: «Кабинет» → «Провайдеры» | Модель по умолчанию |
| :--- | :--- | :--- | :--- | :--- |
| Gemini | бесплатно: [aistudio.google.com](https://aistudio.google.com/) → *Get API key* | `--provider gemini`, `GEMINI_API_KEY` | Gemini, поле «API-ключ» | первая доступная из `gemini-4-hydrogen`, `gemini-3.8-flash`, … |
| OpenAI | [platform.openai.com](https://platform.openai.com/api-keys) | `--provider openai`, `OPENAI_API_KEY` | OpenAI, поле «API-ключ» | первая доступная из `gpt-6.2-sol`, `gpt-6.1-terra`, … |
| Anthropic | [console.anthropic.com](https://console.anthropic.com/) | `--provider anthropic`, `ANTHROPIC_API_KEY` | Anthropic, поле «API-ключ» | первая доступная из `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5` |
| Свой сервер: vLLM, LM Studio, Ollama | ключ не нужен | `--provider openai_compatible --base-url http://…/v1 --model …` | «Локальная модель (OpenAI API)», адрес сервера | первая модель, которую отдаёт сервер |

Если модель не указана (`--model`), агент сам берёт первую доступную ключу модель из списка рекомендованных
(`PREFERRED_MODELS` в [packages/core/req_core/llm.py](packages/core/req_core/llm.py)). Фактическая модель всегда
записывается в паспорт отчёта.

**Куда положить ключ** — у CLI и веба разные места, они не пересекаются:

- **Веб-интерфейс:** только в «Кабинете» → «Провайдеры». Ключи хранятся в базе в зашифрованном виде. В `.env` ключи
  LLM не пишутся — веб их оттуда не читает.
- **CLI:** при запуске — флагом `--api-key` или переменной окружения (`-e GEMINI_API_KEY=…` у Docker). Чтобы не
  вводить каждый раз — отдельный файл настроек CLI: скопируйте [cli.env.example](cli.env.example) в `data/cli.env`,
  раскомментируйте блок своего провайдера и передайте `--env /data/cli.env` (Docker) или `--env data/cli.env`
  (Python). Флаги важнее переменных, переменные важнее файла. `data/` и `cli.env` в git не попадают.
- **`.env` в корне** — только пароли и ключи установки веб-стека (Postgres, Redis, S3, вход админа). Для CLI он нужен
  лишь потому, что без него не запускается `docker compose`.

## CLI

### В Docker

Команда из [быстрого старта](#быстрый-старт). Другие провайдеры:

```powershell
docker compose -p reqcheck-core --profile cli run --rm --build -e ANTHROPIC_API_KEY=ваш-ключ cli /data/requirements.md /data/report.pdf --provider anthropic
```

```powershell
docker compose -p reqcheck-core --profile cli run --rm --build -e OPENAI_API_KEY=ваш-ключ cli /data/requirements.md /data/report.pdf --provider openai
```

Локальная модель на vLLM (ключ не нужен; адрес — ваш). Для моделей с рассуждениями рассуждения выключаются на
проверке требований и включаются на поиске противоречий в наборе; с рассуждениями один запрос идёт минутами,
поэтому `--timeout 900`. Команда одинакова в PowerShell 7 и bash (в Windows PowerShell 5.1 кавычки внутри JSON
пишите как `\"`):

```powershell
docker compose -p reqcheck-core --profile cli run --rm --build cli /data/requirements.md /data/report.pdf --provider openai_compatible --base-url http://vllm.example.local:8000/v1 --model имя-модели --concurrency 4 --max-tokens 48000 --timeout 900 --extra-body '{"chat_template_kwargs":{"enable_thinking":false}}' --extra-body-set-review '{"chat_template_kwargs":{"enable_thinking":true}}'
```

То же без длинных флагов и проблем с кавычками — файлом настроек: скопируйте [cli.env.example](cli.env.example) в
`data/cli.env`, раскомментируйте блок «Свой OpenAI-совместимый сервер» (или другого провайдера) и запустите:

```powershell
docker compose -p reqcheck-core --profile cli run --rm --build cli /data/requirements.md /data/report.pdf --env /data/cli.env
```

`--build` нужен при первом запуске и после обновления кода; дальше его можно опускать.

### Без Docker: Python 3.12+

Как в bbc-agent: `python run.py <файл требований> <файл отчёта>`. Настройки — из `--env FILE`, иначе из `.env`
текущей папки (в корне репозитория это `.env` веб-стека — ключи LLM в него не кладите, используйте `--env`).

Windows (PowerShell):

```powershell
python -m venv .venv
```

```powershell
.venv\Scripts\pip install -e packages/contracts -e packages/core
```

```powershell
.venv\Scripts\python run.py samples/requirements.md data/report.pdf --env data/cli.env
```

Linux:

```bash
python3 -m venv .venv && .venv/bin/pip install -e packages/contracts -e packages/core
```

```bash
.venv/bin/python run.py samples/requirements.md data/report.pdf --env data/cli.env
```

Для PDF нужен шрифт DejaVu Sans (в Docker он уже есть): Linux — пакет `fonts-dejavu-core`, Windows — установите
DejaVu Sans в систему или укажите папку со шрифтом в `REQCHECK_PDF_FONT_DIR`. Без шрифта пишите отчёт в `.md` с
`--no-pdf`. Можно взять готовый `.env` от bbc-agent: `--env путь/к/bbc-agent/.env` — имена переменных совпадают.

### Основные флаги

| Флаг | Что делает |
| :--- | :--- |
| `--provider`, `--model`, `--api-key`, `--base-url` | провайдер (`gemini`, `openai`, `anthropic`, `openai_compatible`, `ollama`), модель, ключ, адрес своего сервера (`…/v1`) |
| `--ask` | задать уточняющие вопросы в консоли и учесть ответы в этом же отчёте |
| `--answers FILE` | ответы файлом (`report.questions.json` прошлого прогона с заполненным `answer`) |
| `--max-questions N` | максимум вопросов автору: 1–6 (5); `--no-questions` — без вопросов |
| `--no-verify` | без верификатора (быстрее, но больше шума) |
| `--also md,json,docx` | ещё форматы рядом с отчётом; `--no-pdf` — не класть PDF рядом с отчётом не в PDF |
| `--concurrency N` | параллельных вызовов модели (1; свой сервер — 4–8) |
| `--timeout S` | таймаут одного вызова, с (600; модели с рассуждениями — 900) |
| `--min-interval S`, `--max-attempts N` | пауза между вызовами и попытки при 429/5xx (бесплатный Gemini — `--min-interval 6`) |
| `--max-tokens N` | лимит ответа модели |
| `--extra-body JSON`, `--extra-body-set-review JSON` | доп. поля запроса для всех вызовов и для рецензентов набора |
| `--no-cache` | не использовать кэш ответов модели |
| `--env FILE` | файл с переменными (`cli.env`) |

Полный список флагов и переменных окружения (как в bbc-agent: `LLM_PROVIDER`, `OPENAI_BASE_URL`, `LLM_CONCURRENCY`,
…) — [docs/cli.md](docs/cli.md) и `--help`.

### Уточняющие вопросы и ответы

Агент формулирует закрытые вопросы автору документа (варианты ответа + свой текст) — там, где без ответа требование
можно понять по-разному. Два способа ответить:

- `--ask` — вопросы задаются в консоли во время прогона (номер варианта или свой текст; Enter — пропустить, `q` —
  закончить), ответы учитываются в этом же отчёте.
- Цикл через файл: после прогона откройте `data/report.questions.json`, впишите ответы в поля `answer` и запустите
  снова с `--answers`:

```powershell
docker compose -p reqcheck-core --profile cli run --rm -e GEMINI_API_KEY=ваш-ключ cli /data/requirements.md /data/report-v2.pdf --answers /data/report.questions.json
```

Агент предложит новые редакции требований и снимет замечания, закрытые ответами.

### Что появляется рядом с отчётом

| Файл | Что это |
| :--- | :--- |
| `report.pdf` | итоговый отчёт; создаётся всегда, даже если основной формат другой (`report.md` → ещё и `report.pdf`) |
| `report.md`, `report.json`, `report.docx` | если заданы расширением отчёта или `--also` |
| `report.questions.json` | вопросы автору с пустым полем `answer` — для `--answers` |
| `.cache/llm/` | кэш ответов модели: повторный прогон того же документа с теми же настройками идёт за секунды (в Docker — `data/.cache/llm`; выключить — `--no-cache`) |

## Веб-интерфейс и стек

Полный стек: веб, API, воркер, Postgres, Redis, Qdrant, S3 (SeaweedFS), эмбеддинги; по желанию — мониторинг и
локальная LLM. Собирается из исходников одной командой. Требования к серверу и подробности —
[docs/deployment.md](docs/deployment.md).

### Установка

Linux (сервер):

```bash
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/work" -w /work alpine:3 sh deploy/secrets/generate.sh
```

```bash
docker compose up -d --build
```

```bash
docker compose ps
```

Windows (PowerShell, Docker Desktop):

```powershell
docker run --rm -v "${PWD}:/work" -w /work alpine:3 sh deploy/secrets/generate.sh
```

```powershell
docker compose up -d --build
```

```powershell
docker compose ps
```

Генератор создаёт `.env` из [.env.example](.env.example) и заполняет пустые пароли случайными значениями; повторный
запуск ничего не перезаписывает. Альтернатива для ключей приложения — `docker compose run --rm --no-deps api python
-m app.keygen` (печатает `APP_ENCRYPTION_KEY` и `APP_SECRET_KEY`). Все настройки `.env` —
[docs/configuration.md](docs/configuration.md).

### Первый вход и провайдер

1. Откройте `http://localhost:8080` (порт — `WEB_PORT` в `.env`). Логин — `ADMIN_USERNAME` (`admin`), пароль —
   `ADMIN_PASSWORD` из `.env`: `Select-String '^ADMIN_PASSWORD=' .env` (PowerShell) или `grep ^ADMIN_PASSWORD= .env`.
2. «Кабинет» → «Провайдеры» → «Добавить провайдера». Мастер проведёт по шагам: провайдер → ключ или адрес → модель →
   параметры → проверка подключения (список моделей приходит от провайдера до сохранения).
3. Свой vLLM-сервер: «Локальная модель (OpenAI API)», адрес вида `http://vllm.example.local:8000/v1`, ключ не нужен. На шаге
   «Параметры» → «Расширенные» есть пресет для vLLM, или вручную: доп. параметры запроса
   `{"chat_template_kwargs":{"enable_thinking":false}}`, для проверки набора — то же с `true`, таймаут запроса — 900 с.

### Работа с документом

1. «Документы» → перетащите файл (PDF, DOCX, MD, TXT), например `samples/requirements.md`.
2. Запустите прогон: провайдер, модель, опции. Флажок **«Спросить меня во время прогона»** (как `--ask`) — прогон
   остановится на вопросах автору и учтёт ответы сразу.
3. Следите за прогоном: конвейер агентов в реальном времени и журнал прогона деревом.
4. Отчёт: текст документа с подсветкой цитат ↔ список замечаний, сводка и итог, матрица, проверка набора,
   чек-лист, паспорт. По замечаниям можно ставить решения (принят / ложное срабатывание / исправлен).
5. Ответьте на вопросы автору и нажмите **«Перепроверить с ответами»** — новый прогон предложит новые редакции
   требований и снимет закрытые замечания.
6. Скачайте отчёт: PDF, DOCX, MD или JSON.

Ещё в интерфейсе: страница «Агенты» (схема конвейера и роль каждого агента), «База знаний» — вики со ссылками
`[[…]]`, которую агент учитывает при проверке, поиск по прошлым прогонам, чат по отчёту, «Расход токенов» (дашборд
по дням и провайдерам), журнал аудита. Языки интерфейса — русский, английский, казахский. Подробнее —
[docs/web.md](docs/web.md).

### Порты

| Адрес | Что | Как включить |
| :--- | :--- | :--- |
| `http://localhost:8080` | веб-интерфейс (`WEB_PORT`) | всегда |
| `http://localhost:3000` | Grafana (`GRAFANA_PORT`), вход `GRAFANA_ADMIN_USER` / `GRAFANA_ADMIN_PASSWORD` | профиль `monitoring` |
| `http://localhost:8081` | демо интерфейса без бэкенда на моках (`WEB_MOCK_PORT`), вход `admin` / `admin` | `docker compose --profile mock up -d --build web-mock` |

Порты публикуются только на `BIND_ADDR` (по умолчанию `127.0.0.1`); TLS и домен — обратным прокси на хосте
([пример nginx](deploy/nginx/host-example.conf)).

## Как устроен агент

Конвейер агентов в стиле bbc-agent над общим графом памяти (`packages/core/req_core/agent`):

1. **Чтение** документа в пронумерованные строки и **правила без LLM** — подсказки агентам (размытые слова,
   заглушки, неописанные коды ответов и т. п.).
2. **Нарезчик** выделяет требования; контроль покрытия возвращает модели непокрытые строки.
3. **Планировщик** строит матрицу «требование × 9 критериев 29148»; **инспектор** проверяет каждую клетку,
   **6 рецензентов набора** (логика правил, согласованность спецификаций, системный аналитик, тест-аналитик,
   архитектор интеграций, риски и ИБ) ищут противоречия и пробелы параллельно.
4. **Контроль достоверности кодом**: замечание без цитаты из документа не принимается, ссылки сверяются.
5. **Верификатор** пытается опровергнуть каждое замечание, сливает дубли и калибрует серьёзность.
6. **Аналитик уточнений** — вопросы автору и чек-лист ревью; ответы превращаются в новые редакции требований.
7. **Итог** руководителя ревью: можно ли в разработку, что исправить первым; предохранители кодом.

Подробно — [docs/agent.md](docs/agent.md); сервисы и данные — [docs/architecture.md](docs/architecture.md); HTTP
API — [docs/api.md](docs/api.md); бэкенд — [docs/backend.md](docs/backend.md).

## Развёртывание

| Профиль | Что добавляет |
| :--- | :--- |
| (без профиля) | web, api, migrate, worker, embedder, postgres, redis, qdrant, seaweedfs |
| `monitoring` | Prometheus, Grafana, Loki, экспортеры ([docs/monitoring.md](docs/monitoring.md)) |
| `offline` / `gpu` | локальная LLM (Ollama) на CPU с моделями в образе / на NVIDIA GPU — включайте один |
| `backup` | бэкап и восстановление в `./backups/` |
| `cli` | разовый прогон агента |
| `test` | тесты |
| `mock` | веб на моках без бэкенда |

Профили включаются строкой `COMPOSE_PROFILES=monitoring,…` в `.env` или флагом `--profile`. Обновление: бэкап →
`git pull` → `docker compose up -d --build` (миграции применяются сами). Бэкапы по cron, восстановление,
офлайн-установка, GPU — [docs/deployment.md](docs/deployment.md).

## Решение проблем

| Симптом | Что делать |
| :--- | :--- |
| `required variable … is missing a value` при `docker compose` | нет `.env` или в нём пустые пароли (например, после `Copy-Item .env.example .env`) — запустите генератор секретов из [быстрого старта](#быстрый-старт) |
| `429` / `RESOURCE_EXHAUSTED` у бесплатного Gemini | агент сам ждёт и повторяет; при частых ограничениях добавьте `--min-interval 6` |
| таймауты у моделей с рассуждениями | `--timeout 900` (в вебе — «Таймаут запроса» 900 в параметрах провайдера) |
| сборка веба падает с `unable to verify the first certificate` | корпоративный прокси подменяет TLS: положите корневой сертификат в `services/web/certs/*.crt` ([подробно](services/web/certs/README.md)) |
| модель отказывается отвечать на часть запросов | прогон предупредит об этом в журнале; используйте другую модель |
| Ollama на хосте не видна из контейнера `cli` | `localhost` в контейнере — это сам контейнер; на Docker Desktop укажите `--base-url http://host.docker.internal:11434/v1` |
| `Не найден шрифт DejaVuSans.ttf` при `python run.py` | см. [Без Docker](#без-docker-python-312) или запускайте в Docker |
| остановить стек | `docker compose down` — данные в томах сохраняются; `docker compose down -v` — **удаляет все данные** ReqCheck |

На общем сервере не запускайте `docker system prune` / `docker image prune`: они затрагивают чужие контейнеры и
образы. Удаляйте только образы ReqCheck по имени.

## Тесты

Все тесты — только в Docker, отдельным проектом `reqcheck-test`, чтобы не задеть рабочий стек:

```bash
docker compose -p reqcheck-test --profile test run --rm --build test-contracts
```

```bash
docker compose -p reqcheck-test --profile test run --rm --build test-core
```

```bash
docker compose -p reqcheck-test --profile test run --rm --build test-api
```

```bash
docker compose -p reqcheck-test --profile test run --rm --build test-worker
```

```bash
docker compose -p reqcheck-test --profile test run --rm --build test-embedder
```

```bash
docker compose -p reqcheck-test --profile test run --rm --build test-web
```

```bash
docker compose -p reqcheck-test --profile test run --rm --build test-infra
```

Уборка (удаляет только тома проекта `reqcheck-test`):

```bash
docker compose -p reqcheck-test --profile test down -v
```

Команды одинаковы в PowerShell и bash. Замер полноты выделения требований — [docs/cli.md](docs/cli.md#замер-полноты).

## Структура репозитория

```
packages/
  contracts/        общие модели данных (Report, ProviderConfig, …) — контракт между частями
  core/             ядро: чтение документов, агенты (req_core/agent), LLM-клиенты, отчёты, CLI (req_core/cli.py)
services/
  api/  worker/     FastAPI и Celery-воркер
  embedder/         эмбеддинги для поиска и базы знаний
  web/              веб-интерфейс (React)
  cli/              образ CLI
deploy/             секреты, nginx, мониторинг, Ollama, бэкапы
samples/            requirements.md — документ организаторов
docs/               документация
run.py              запуск CLI: python run.py <требования> <отчёт>
compose.yaml        весь стек и профили
.env.example        шаблон секретов установки
cli.env.example     шаблон настроек модели для CLI
```

## Документация

- [docs/task.md](docs/task.md) — постановка задачи
- [docs/agent.md](docs/agent.md) — как агент проверяет документ
- [docs/cli.md](docs/cli.md) — все флаги и переменные CLI
- [docs/architecture.md](docs/architecture.md) — сервисы, данные, потоки
- [docs/deployment.md](docs/deployment.md) — развёртывание, обновление, бэкапы, офлайн, GPU
- [docs/configuration.md](docs/configuration.md) — настройки `.env`
- [docs/monitoring.md](docs/monitoring.md) — метрики, дашборд, логи
- [docs/backend.md](docs/backend.md), [docs/api.md](docs/api.md) — бэкенд и HTTP API
- [docs/web.md](docs/web.md) — веб-интерфейс, языки, тема, демо-режим
- [BACKLOG.md](BACKLOG.md) — бэклог
