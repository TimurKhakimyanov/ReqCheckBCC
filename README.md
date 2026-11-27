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
