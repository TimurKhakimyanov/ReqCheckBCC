# ReqCheck — агент проверки требований

ИИ-агент статической проверки документа с требованиями по ISO/IEC/IEEE 29148:2018 (п. 5.2.5, 5.2.6)
и IEEE Std 830-1998 (п. 4.3). Выделяет требования, проверяет каждое и набор целиком, пишет отчёт на русском.
Есть CLI (одна команда) и веб-интерфейс со стеком для развёртывания у себя.

- Постановка: [docs/task.md](docs/task.md)
- Архитектура: [docs/architecture.md](docs/architecture.md), HTTP API: [docs/api.md](docs/api.md)
- Бэклог: [BACKLOG.md](BACKLOG.md)

<!-- ===================== Раздел сессии «Ядро» ===================== -->
## Быстрый прогон агента (CLI)

Агент принимает путь к документу требований (PDF, DOCX, MD, TXT) и путь к файлу отчёта. Нужен только Docker.

**1. Ключ LLM.** Бесплатный ключ Gemini: [aistudio.google.com](https://aistudio.google.com/) → *Get API key* →
*Create API key*. Для бесплатного тарифа достаточно.

**2. Куда положить.** В файл `.env` в корне репозитория (в git не попадает):

```powershell
Copy-Item .env.example .env
```

В `.env` заполните `GEMINI_API_KEY=...`. Другие провайдеры: `LLM_PROVIDER=openai` + `OPENAI_API_KEY`,
`LLM_PROVIDER=anthropic` + `ANTHROPIC_API_KEY`, локальная модель — `LLM_PROVIDER=openai_compatible` +
`OPENAI_COMPATIBLE_BASE_URL` (Ollama, vLLM) + `OPENAI_COMPATIBLE_MODEL`.

**3. Модель.** `LLM_MODEL` в `.env`. Если пусто — агент берёт первую доступную ключу модель из списка
рекомендованных (Gemini: `gemini-4-hydrogen` → `gemini-3.8-flash` → `gemini-3.6-flash` → …).
Фактическая модель всегда записывается в паспорт отчёта. Temperature 0, структурированный JSON-вывод.

**4. Запуск одной командой.** Положите документ в каталог `data/` и выполните:

```powershell
docker compose -p reqcheck-core --profile cli run --rm --build cli /data/requirements.pdf /data/report.md
```

**5. Отчёт** ляжет в `data/report.md`. Формат определяется по расширению (`.md`, `.json`, `.docx`, `.pdf`);
несколько форматов сразу — `--also json,docx,pdf`. Прогресс выводится в терминал.

Полезные флаги: `--provider gemini|openai|anthropic|openai_compatible`, `--model <id>`, `--verify` (второй
проход-критик перепроверяет дефекты), `--no-split` (не выделять подтребования), `--help`.
Версия агента в паспорте отчёта — из `git describe` (в Docker — из `AGENT_VERSION` при сборке):

```powershell
$env:AGENT_VERSION = git describe --always --dirty; docker compose -p reqcheck-core --profile cli run --rm --build cli /data/requirements.pdf /data/report.md
```

Если бесплатный Gemini отвечает `429`, агент сам ждёт и повторяет запрос; при частых ограничениях задайте
`LLM_MIN_INTERVAL_S=6` в `.env`.

### Как агент проверяет

1. **Чтение**: PDF (текст, таблицы, заголовки по размеру шрифта, номера страниц), DOCX (включая таблицы),
   MD, TXT → нормализованный текст; все ссылки в отчёте — смещения в этом тексте.
2. **Нарезка**: LLM + детерминированные подсказки (идентификаторы «Ф-N», строки критериев приёмки, параметры
   и коды ответов API, абзацы НФТ/данных/интеграции). Составные требования делятся на подтребования `R-002.1`.
3. **Правила без LLM**: размытые слова (RU/EN), «TBD / заполняются позже», пустые поля шаблона, версия документа.
4. **Каждое требование** — по 10 критериям ISO/IEC/IEEE 29148 п. 5.2.5 / IEEE 830 п. 4.3 (пакетами).
5. **Набор** — противоречия между требованиями, критериями приёмки и дочерней спецификацией, единицы
   измерения, пропуски; оценка по 8 критериям п. 5.2.6.
6. **Проверка цитат кодом**: каждая цитата модели ищется в тексте (нормализация, нечёткий поиск); дефект без
   подтверждённой цитаты отбрасывается или привязывается к месту требования с пометкой.
7. Чек-лист «Ревью требований» (если есть в документе), **сводка** и **итог** (можно ли начинать разработку
   и тестирование, что исправить первым).

Замер полноты на примере: `packages/core/eval/recall.py` + эталон `packages/core/eval/requirements_md_reference.json`
(эталон в промптах не используется).

<!-- ===================== Раздел сессии «Инфраструктура» ===================== -->
## Развёртывание

> Раздел дописывает сессия «Инфраструктура».

```bash
cp .env.example .env   # заменить все change-me
docker compose up -d --build
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
Ключи LLM вводятся в кабинете и хранятся в Postgres зашифрованными (Fernet, `APP_ENCRYPTION_KEY`). Если ключ уже есть
в `.env` (`GEMINI_API_KEY` и т. д.), api при старте запишет его в кабинет, пока там пусто.
Не меняйте `APP_ENCRYPTION_KEY` после ввода ключей — их придётся ввести заново.

**Прогон и прогресс.** `POST /api/runs` ставит задачу в очередь Redis; воркер публикует события в канал `run:{id}:events`,
api отдаёт их по SSE (`GET /api/runs/{id}/events`, сначала текущее состояние). Отмена — флаг в Redis: ядро прерывается
на ближайшем событии прогресса. Прогон дольше `RUN_TIMEOUT_S` завершается ошибкой. Ошибки провайдера (неверный ключ,
лимит 429, таймаут) пишутся в `runs.error` понятным текстом.

**Поиск и база знаний.** Qdrant: коллекция `knowledge` (при первом старте туда индексируется пересказ критериев
29148/830; загруженные PDF/DOCX/MD/TXT и заметки режутся на фрагменты) и `requirements` (требования и дефекты прошлых
прогонов). Фрагменты базы знаний подмешиваются в прогон (`ValidationOptions.knowledge_snippets`) и в чат.
Эмбеддинги: `EMBEDDINGS_PROVIDER=local|gemini|openai`. При смене модели меняется размерность — коллекции
пересоздаются, а api при старте переиндексирует базу знаний и отчёты.

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
- **Тема и стиль**: все цвета, радиусы и шрифты — CSS-переменные в `services/web/src/index.css` (светлая и тёмная).
  Перекраска под фирменный стиль — правка токенов, компоненты не трогаются.
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
