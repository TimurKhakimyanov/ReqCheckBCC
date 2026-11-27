# ReqCheck для ИИ-агента: как устроено и как подключиться

Краткая справка для ИИ-агента, который будет стыковаться с ReqCheck. Факты сверены с ветками
`claude/core-agent-19ce12` (ядро), `claude/backend-4accf6` (API, воркер), `claude/web-ui-f4bd67`,
`claude/infra-a2f941` и `main` на 2026-11-27. Подробнее: [architecture.md](../architecture.md),
[api.md](../api.md) (свежая версия — в ветке бэкенда), [ТЗ](../task.md), [BACKLOG.md](../../BACKLOG.md).

## 1. Что делает система

ИИ-агент статической проверки готового документа требований по ISO/IEC/IEEE 29148:2018 (п. 5.2.5 — отдельное
требование, п. 5.2.6 — набор) и IEEE Std 830-1998 (п. 4.3). Постановка — [docs/task.md](../task.md).

- **Вход:** файл PDF, DOCX, MD или TXT. Пример от организаторов — `samples/requirements.md`.
- **Выход:** объект `Report` (Pydantic, `req_contracts`), рендерится в MD / JSON / DOCX / PDF.
  В отчёте: паспорт прогона, нарезка на требования, оценка каждого требования и набора по 18 критериям,
  дефекты с дословными цитатами, чек-лист ревью (если он есть в документе), сводка и итог
  (готов ли документ к разработке и тестированию, что исправить первым).
- Каждый дефект обязан ссылаться на конкретное место документа (`SourceLocation`), цитата проверяется кодом.

## 2. Карта репозитория и сервисов

| Каталог | Что | Кто вызывает |
| :--- | :--- | :--- |
| `packages/contracts` (`req_contracts`) | Общие модели: `Report`, `Finding`, `Criterion`, `ProgressEvent`, `ProviderConfig`, `ValidationOptions` | все |
| `packages/core` (`req_core`) | Агент: парсинг, нарезка, правила, LLM-проверки, проверка цитат, рендер, провайдеры, чат | worker, api, cli |
| `services/api` | FastAPI, `/api/*`, Postgres, S3, Qdrant, SSE | web |
| `services/worker` | Celery-задача `reqcheck.run_validation(run_id)` → `req_core.validate_document` | api через Redis |
| `services/embedder` | Эмбеддинги (`multilingual-e5-small` локально или провайдер) | api, worker |
| `services/web` | React SPA + nginx, проксирует `/api/*` → `api:8000` | пользователь |
| `services/cli` | Тот же `req_core`, прогон одной командой | человек / скрипт |
| `deploy/` | compose-обвязка: postgres, redis, qdrant, seaweedfs, мониторинг, ollama | — |

Поток прогона: `web` → `POST /api/documents` (файл в S3) → `POST /api/runs` → Celery → воркер скачивает файл,
берёт настройки провайдера из Postgres, подмешивает фрагменты базы знаний из Qdrant в
`options.knowledge_snippets`, вызывает `validate_document(..., on_progress=...)` → события в Redis
`run:{id}:events` → API отдаёт их по SSE → отчёт в Postgres, выгрузки в S3, требования и дефекты индексируются в Qdrant.
Чат по отчёту API вызывает напрямую через `answer_question`.

## 3. Контракты (`packages/contracts/req_contracts`)

Владелец — `main`. Менять только согласованно, с подъёмом `SCHEMA_VERSION` (сейчас `"1.1"`).
JSON Schema отчёта: `req_contracts/fixtures/report.schema.json`; пример отчёта: `req_contracts/fixtures/sample_report.json`.

**`Report`** (`report.py`):
`schema_version`, `passport: RunPassport` (document_name, document_sha256, run_at, provider, model, agent_version,
standards), `document: ParsedDocument` (name, format, sha256, **text**, page_offsets), `requirements: [Requirement]`,
`requirement_assessments: [RequirementAssessment]`, `set_assessment: SetAssessment`, `findings: [Finding]`,
`checklist: [ChecklistItem]`, `questions: [ClarifyingQuestion]` (с 1.1), `summary: Summary`, `conclusion: Conclusion`, `usage: Usage`.

- `Requirement`: `id` (`R-001`, подтребования `R-002.1`), `source_id` (id в документе, напр. «Ф-1»), `parent_id`,
  `kind` (functional, non_functional, data, integration, api, ui, acceptance, other), `summary`, `location`.
- `Finding`: `id` (`D-001`), `scope` (requirement | set), `requirement_ids`, `criterion`, `severity`
  (critical | major | minor), `title`, `explanation`, `locations` (минимум одна), `suggestion`, `source` (llm | rule).
- `SourceLocation`: `section`, `quote` (дословно), `char_start`/`char_end` — смещения в `ParsedDocument.text`,
  `page` (для PDF), `verified` — цитата найдена в тексте кодом.
- `CriterionCheck`: `criterion`, `verdict` (pass | fail | not_applicable), `comment`, `finding_ids`.
- `Conclusion`: `ready_for_development`, `ready_for_testing`, `rationale`, `top_fixes`.
- `ClarifyingQuestion`: `id` (`Q-01`), `question`, `why`, `addressee`, `priority` (blocker | important | minor),
  `finding_ids`, `options` (2–4 варианта ответа).
- `Usage`: `llm_calls`, `prompt_tokens`, `completion_tokens`, `cost_usd` (пока не считается), `duration_s`.

**`Criterion`** (`criteria.py`) — 18 кодов; описания и ссылки на пункты стандартов — в `CRITERIA`:
- требование (10, `REQUIREMENT_CRITERIA`): `necessary`, `implementation_free`, `unambiguous`, `complete`,
  `singular`, `feasible`, `verifiable`, `correct`, `conforming`, `traceable`;
- набор (8, `SET_CRITERIA`): `set_complete`, `set_consistent`, `set_feasible`, `set_comprehensible`,
  `set_validatable`, `set_ranked`, `set_modifiable`, `set_traceable`.

**`ProgressEvent`** (`events.py`): `run_id`, `stage: RunStage`, `progress` (0..1, монотонный), `message`,
`current`, `total`, `ts`. `ProgressCallback = Callable[[ProgressEvent], None]`.
Ядро шлёт стадии `parsing → segmenting → rule_checks → checking_requirements → checking_set → verifying → done`
(на `checking_requirements` `current/total` — номер требования, событие на каждое). `queued`, `failed`, `cancelled`
выставляет API, `rendering` (выгрузка отчёта и индексация) — воркер после ядра.

**`ProviderConfig`** (`llm.py`) — всё для вызова модели; ядро не читает окружение, если конфиг передан:
| Поле | По умолчанию | Смысл |
| :--- | :--- | :--- |
| `provider` | — | `gemini` / `openai` / `anthropic` / `openai_compatible` |
| `model` | — | `""` — ядро выберет первую доступную из рекомендованных; итог в `passport.model` |
| `api_key` | `None` | `SecretStr`; для `openai_compatible` необязателен |
| `base_url` | `None` | обязателен для `openai_compatible` |
| `temperature` | `0.0` | не отправляется моделям, которые её отклоняют |
| `max_output_tokens` | `None` | `None` — ядро берёт с запасом (модели с рассуждениями тратят токены на reasoning) |
| `timeout_s` | `180.0` | таймаут одного запроса к модели, с |
| `min_interval_s`, `max_attempts` | `0`, `6` | пауза между вызовами; попытки при 429/5xx/сети |
| `extra_body` | `None` | доп. поля тела запроса OpenAI-совместимого сервера |
| `extra_body_set_review` | `None` | переопределение `extra_body` только для проверки набора; `None` — как `extra_body` |

**`ValidationOptions`**: `language="ru"`, `verify_pass=True` (верификатор), `split_compound=True`,
`fill_checklist=True`, `ask_questions=True`, `max_questions=15`, `knowledge_snippets=[]` (RAG-фрагменты в промпт), `batch_size=6`, `concurrency=1`.

## 4. Публичный интерфейс ядра (`req_core/__init__.py`)

Воркер, API и CLI импортируют только это. Сигнатуры зафиксированы:

```python
parse_document(path: Path, *, name: str | None = None) -> ParsedDocument
validate_document(path: Path, llm: ProviderConfig, *, options: ValidationOptions | None = None,
                  on_progress: ProgressCallback | None = None, document_name: str | None = None) -> Report
render_report(report: Report, fmt: Literal["md", "json", "docx", "pdf"]) -> bytes
get_llm(cfg: ProviderConfig) -> LLMClient      # Protocol: complete(), stream(), complete_json(system, user, schema)
list_models(cfg: ProviderConfig) -> list[str]  # живой список моделей провайдера
answer_question(report: Report, history: list[ChatMessage], question: str, llm: ProviderConfig,
                knowledge_snippets: list[str] | None = None) -> Iterator[str]   # поток токенов чата по отчёту
```

**Конвейер** — агенты bbc-agent в `req_core/agent` (вход — `req_core/pipeline.py: run_pipeline`, прогон —
`agent/run.py: Run`):
1. Чтение (`parsing.py`) → `ParsedDocument.text`; `agent/ingest.py: from_parsed` режет текст на строки `L<n>|`
   с разделами и смещениями — модель ссылается на строки, отчёт получает строки и точные символы.
2. Правила (`agent/rules.py: run_rules` + проверки ReqCheck `rules.rule_findings`) — подсказки (`hint`) в граф.
3. Нарезчик (`agent/agents/extractor.py`): модель по частям документа, затем контроль покрытия
   (`extractor_gaps.md`); кандидаты правил ReqCheck (`rules.segment_hints`), не взятые и не объяснённые моделью,
   добавляются.
4. Планировщик (`agents/planner.py`): интенты «инспекция пачки требований» и «ревью набора ролью» в общем пуле
   (`concurrency`); раунды до заполнения матрицы «требование × критерий» (до 4, пачки вдвое меньше). Инспектор —
   `agents/inspector.py` (`inspector.md`), рецензенты — `agents/reviewers.py` (`reviewer.md`, роли в `PERSPECTIVES`;
   для них применяется `extra_body_set_review`, только в их потоке).
5. Запись замечания (`agents/common.py: record_finding`) — контроль достоверности (`agent/guard.py`): без найденной
   цитаты не принимается, выдуманные цитаты в объяснении и ссылки на несуществующие объекты отмечаются/вычищаются.
6. Верификатор (`agents/verifier.py`, `verifier.md`, `dedup.md`): перепроверка, слияние дублей, финальные `D-xxx`.
7. Вопросы автору (`agents/clarifier.py`, `clarifier.md`), чек-лист (`agents/finalizer.py: checklist`), редакции
   по ответам (`resolver.md`, при `ValidationOptions.answers`), итог (`finalizer.verdict`, `verdict.md`).
8. Сборка `Report` из графа (`Run._report`), предохранители итога, удаление иероглифов.

**Куда встраивать новую проверку / своего агента:**
- Детерминированная проверка — `agent/rules.py: run_rules` (подсказка `Hint` по номеру строки).
- Агент — промт `agent/prompts/<имя>.md` (`# SYSTEM` / `# USER`, переменные `{{…}}`, `version:`), модуль в
  `agent/agents/`, вызов `ctx.llm.json(роль, system, user, label=…, prompt="<имя>")`, замечания — через
  `record_finding` (так они пройдут контроль достоверности и верификатор). Шаг — в `Run._run`.
- Свой LLM-клиент — объект с `complete_reply(system, user, max_tokens, name=…) -> Reply` (иначе `complete`);
  `run_pipeline(doc, client, options=..., on_progress=...)` — внутренний интерфейс, стабилен только `__init__.py`.

**Правила ядра:**
- Ответ модели агентам — JSON по схеме из промта (разбор, спасение оборванного ответа, повтор с пояснением);
  размер запроса проверяется до вызова по окну модели (`ProviderConfig.context_tokens`). temperature 0, повторы
  при 429/5xx.
- Каждая цитата модели проверяется кодом (`SourceLocation.verified`); дословные цитаты — обязательны.
- Прогресс — только через `on_progress`. Исключение из `on_progress` не глотается и прерывает прогон
  (так воркер реализует отмену и таймаут), в том числе во время паузы перед повтором при 429.
- Ошибки: `req_core.llm.LLMConfigError` (нет ключа / `base_url`) и 401/403/404 провайдера роняют прогон сразу.
  Сбой отдельного пакета проверки прогон не роняет — отмечается в `conclusion.rationale`.

## 5. Как встроиться

**Как библиотека.** `uv pip install packages/contracts packages/core`, затем:

```python
from pathlib import Path
from req_contracts import ProviderConfig, ProviderName, ValidationOptions
import req_core

cfg = ProviderConfig(provider=ProviderName.OPENAI_COMPATIBLE, model="<модель>",
                     base_url="http://vllm.example.local:8000/v1")
report = req_core.validate_document(Path("doc.md"), cfg, options=ValidationOptions(concurrency=4),
                                    on_progress=lambda e: print(e.stage, e.progress))
Path("report.md").write_bytes(req_core.render_report(report, "md"))
```

Для PDF-рендера в образе нужен шрифт DejaVu (`fonts-dejavu-core` или `REQCHECK_PDF_FONT_DIR`).

**Как отдельный сервис через HTTP API.** Базовый путь `/api`, JSON, авторизация — httpOnly cookie `session`
после `POST /api/auth/login`. Полный OpenAPI — `/api/openapi.json` (первичен).
| Метод | Путь | Назначение |
| :--- | :--- | :--- |
| POST | `/documents` | multipart `file` → `Document` |
| POST | `/runs` | `{document_id, provider, model, options?: ValidationOptions}` → `Run` (202) |
| GET | `/runs/{id}/events` | **SSE**: `event: progress`, `data: ProgressEvent`; сначала текущее состояние, последнее — `done`/`failed`/`cancelled` |
| GET | `/runs/{id}/report` | `Report` (404, пока не готов); `/report.{md,docx,pdf,json}` — файл |
| GET / PATCH | `/runs/{id}/findings[/{finding_id}]` | дефекты + статус ревью `open / accepted / false_positive / fixed` |
| POST | `/runs/{id}/cancel` | отмена прогона |
| POST | `/runs/{id}/chat` | **SSE**: `event: token` (`{"text": ...}`), в конце `event: done` (`ChatMessage`) |
| GET | `/search?q&kind=requirement\|finding` | семантический поиск по прошлым прогонам (Qdrant) |
| GET / PUT | `/providers[/{provider}]`, `POST /providers/{p}/test`, `GET /providers/{p}/models` | настройки LLM |
| GET | `/health` | состояние зависимостей |

Ошибки: `{"detail": "...", "code": "..."}`. Для прокси перед SSE: `proxy_buffering off; proxy_read_timeout 1h`.

**Через CLI.** Положить документ в `data/`:

```powershell
docker compose -p reqcheck-core --profile cli run --rm --build -e GEMINI_API_KEY=<ключ> cli /data/requirements.pdf /data/report.md
```

Формат по расширению (`.md/.json/.docx/.pdf`), ещё форматы — `--also json,docx`. Флаги: `--provider`, `--model`,
`--api-key`, `--base-url`, `--verify`, `--no-split`, `--no-checklist`, `--max-tokens`, `--extra-body`,
`--extra-body-set-review`, `--timeout`, `--min-interval`, `--max-attempts`, `--batch-size`, `--concurrency`, `--name`.
Для машинной обработки удобнее `report.json` — он валидируется `Report.model_validate_json`.

**Что нельзя ломать:** модели `req_contracts` и `SCHEMA_VERSION` без согласования; сигнатуры в
`req_core/__init__.py`; формат SSE-событий (`progress`, `token`, `done`); идентификаторы `R-xxx` / `D-xxx` и коды
`Criterion`; смысл смещений (`char_start`/`char_end` — в `ParsedDocument.text`); требование «у каждого дефекта есть
хотя бы одна `location`».

## 6. LLM-провайдеры и настройки

- Провайдеры: `gemini`, `openai`, `anthropic`, `openai_compatible` — собственный тонкий слой над официальными
  SDK (`google-genai`, `openai`, `anthropic`); LiteLLM не используется. `openai_compatible` = OpenAI SDK с
  `base_url` (vLLM, Ollama, LM Studio); ключ не нужен, `list_models` = `GET {base_url}/models`.
- **Всё про ИИ задаётся в админке, не в `.env`**: api и worker не читают из окружения ключи, модели и параметры
  LLM. Ключи хранятся в Postgres зашифрованными (Fernet). Параллельность, размер пакета, паузы — в `/settings`.
  Переменные `GEMINI_API_KEY` и т. п. читает только CLI.
- Локальная модель: провайдер `openai_compatible`, `base_url` вида `http://vllm.example.local:8000/v1`, без ключа.
  В профилях compose `offline` / `gpu` поднимается ollama (`http://ollama:11434`); конкретная модель для них
  ещё не выбрана (BACKLOG).
- **Пресет для моделей с рассуждениями** (vLLM): рассуждения выключены на проверке требований и включены на
  поиске противоречий в наборе, большой лимит ответа, таймаут запроса 900 с (с рассуждениями один запрос проверки
  набора идёт 3–5 минут; при 180 с — таймауты и повторы):
  ```json
  {"extra_body": {"chat_template_kwargs": {"enable_thinking": false}},
   "extra_body_set_review": {"chat_template_kwargs": {"enable_thinking": true}},
   "max_output_tokens": 48000, "timeout_s": 900}
  ```
  Воркер сам поднимает общий таймаут прогона до `1.2 × timeout_s`, если он короче.
- Anthropic: структурированный вывод через `output_config.format`, цепочка native → tool(auto) → prompt; отказ
  по возможностям запоминается на (провайдер, base_url, модель) в пределах процесса.

## 7. Запуск и тесты

- **Только в Docker**, на хосте ничего не ставим и не запускаем:
  `docker compose -p <имя> --profile test run --rm --build test-<сервис>`, где сервис — `contracts`, `core`,
  `api`, `worker`, `embedder`, `web`, `infra`. Свой `-p <имя>`, чтобы не задеть чужие контейнеры на хосте.
- Тесты не ходят в сеть и во внешние LLM. Фейковый провайдер: `from req_core.testing import FakeLLM`.
  Агентам по умолчанию отвечает «{}» — работают только кандидаты правил в нарезке; сценарий задаётся словарём по
  имени промта: `FakeLLM({"extractor": ..., "inspector": ..., "reviewer": ..., "verifier": ..., "dedup": ...,
  "clarifier": ..., "checklist": ..., "verdict": ..., "resolver": ...})` (значение — dict, JSON или функция
  `(system, user)`). `FakeLLM.calls` хранит все запросы (`prompt` — имя промта). Пример сценария —
  `packages/core/tests/test_pipeline.py`.
- Живой прогон — отдельная команда CLI (раздел 5), требует ключа или локального `base_url`.
- Замер полноты по эталону: `python eval/recall.py report.json eval/requirements_md_reference.json` в каталоге
  `packages/core` (23 эталонных дефекта для `samples/requirements.md`; в промптах эталон не используется).

## 8. Ограничения и текущее качество

По живым прогонам ядра на `samples/requirements.md` (42 требования):
- Полнота — 21 из 23 эталонных дефектов.
- Много шума: около 89–90 дефектов на документ при 23 эталонных.
- Заметный разброс результатов между прогонами.
- Пример длительности: `mimo-v2.6-flash`, concurrency 4, рассуждения off/on — около 8 мин, 11 вызовов LLM.

Не реализовано (подробно — [BACKLOG.md](../../BACKLOG.md)): OCR сканированных PDF (сейчас — понятная ошибка),
автонумерация списков DOCX, кеш ответов LLM, подсчёт `cost_usd`, проверка на документах 100+ страниц,
self-consistency (несколько прогонов проверки набора), принудительная остановка зависшего вызова LLM
(поток ядра доживает до ответа провайдера), один пользователь-админ без ролей и SSO, CI/CD.
