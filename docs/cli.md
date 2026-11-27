# CLI агента: все флаги и переменные

Короткая версия — в [README](../README.md#cli). Справка самого агента: `python run.py --help` или
`docker compose -p reqcheck-core --profile cli run --rm --build cli --help`.

## Откуда берутся настройки

Порядок важности: **флаги** → **переменные окружения** (в том числе `-e` у `docker compose run`) → **файл с
переменными**. Файл — это `--env FILE` или, если флаг не задан, `.env` в текущей папке. Уже заданные переменные
окружения файл не перезаписывает (как `load_dotenv(override=False)` в bbc-agent).

- `python run.py` из корня репозитория читает корневой `.env`. В нём лежат только секреты веб-стека — LLM-переменные
  туда не пишите: веб их не читает, а смешивать установку и CLI незачем. Для CLI заведите отдельный файл
  ([cli.env.example](../cli.env.example) → `data/cli.env`) и передавайте `--env data/cli.env`.
- В Docker текущая папка контейнера — `/data` (это `./data` на хосте), поэтому файл передаётся как
  `--env /data/cli.env`. Корневой `.env` в контейнер CLI не попадает.
- Можно взять готовый `.env` от bbc-agent: `--env путь/к/bbc-agent/.env` — имена переменных совпадают.

## Переменные (как в bbc-agent)

| Переменная | Что задаёт |
| :--- | :--- |
| `LLM_PROVIDER` | `gemini`, `openai` (с `OPENAI_BASE_URL` не на api.openai.com — любой OpenAI-совместимый сервер: vLLM, LM Studio), `ollama`, `anthropic`, `openai_compatible`. Не задан — по найденному ключу или адресу, иначе `gemini` |
| `GEMINI_API_KEY` (или `GOOGLE_API_KEY`), `GEMINI_MODEL` | Gemini |
| `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_BASE_URL` | OpenAI или OpenAI-совместимый сервер (для vLLM без авторизации ключ не нужен) |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Anthropic |
| `OPENAI_COMPATIBLE_BASE_URL`, `OPENAI_COMPATIBLE_MODEL`, `OPENAI_COMPATIBLE_API_KEY` | провайдер `openai_compatible` явно |
| `OLLAMA_BASE_URL`, `OLLAMA_MODEL` | Ollama (по умолчанию `http://localhost:11434`) |
| `LLM_MODEL` | модель для любого провайдера |
| `LLM_CONCURRENCY` | параллельных вызовов: локальный сервер — 8, бесплатный Gemini — 1 |
| `AGENT_BATCH_SIZE` | требований на один вызов инспектора (5) |
| `LLM_MAX_TOKENS`, `LLM_TIMEOUT`, `LLM_MIN_INTERVAL`, `LLM_MAX_RETRIES`, `LLM_TEMPERATURE` | лимит ответа, таймаут вызова (600 с), пауза между вызовами, повторы при 429/5xx, температура (0) |
| `LLM_CONTEXT_TOKENS` | окно модели; по умолчанию его сообщает сервер (vLLM — `max_model_len`) |
| `LLM_EXTRA_BODY`, `LLM_EXTRA_BODY_REVIEWER` | доп. параметры запроса для всех ролей и для рецензентов набора (JSON) |
| `LLM_CACHE_DIR` | кэш ответов модели (по умолчанию `.cache/llm` в текущей папке; в Docker — `data/.cache/llm`) |

Своя модель или лимит на отдельную роль (`MODEL_<РОЛЬ>`, `LLM_MAX_TOKENS_<РОЛЬ>`) и `LLM_TRUNCATION_FALLBACK_BODY`
в Zoe не поддерживаются — агент предупредит, если они заданы.

## Флаги

| Флаг | Что делает |
| :--- | :--- |
| `input`, `output` | путь к документу (PDF, DOCX, MD, TXT) и к отчёту; формат отчёта — по расширению (`.pdf`, `.md`, `.json`, `.docx`; без расширения — PDF) |
| `--provider` | `gemini`, `openai`, `anthropic`, `openai_compatible`, `ollama` |
| `--model`, `--api-key`, `--base-url` | модель, ключ, адрес OpenAI-совместимого API (`…/v1`) |
| `--max-tokens` (`--max-output-tokens`) | лимит ответа модели |
| `--timeout` | таймаут одного вызова, с (600) |
| `--concurrency`, `--batch-size` | параллельных вызовов; требований на вызов инспектора |
| `--min-interval`, `--max-attempts` | пауза между вызовами, с; попыток на вызов при 429/5xx |
| `--context-tokens` | окно модели, если сервер его не сообщает |
| `--extra-body`, `--extra-body-set-review` | доп. поля запроса (JSON) для всех вызовов и для рецензентов набора |
| `--ask` | задать уточняющие вопросы в консоли (номер варианта или свой текст; Enter — пропустить, `q` — закончить) и учесть ответы в этом же отчёте |
| `--answers FILE` | ответы файлом: `<отчёт>.questions.json` с заполненным полем `answer` или JSON `{"Q-01": "ответ"}` |
| `--max-questions N` | максимум вопросов: от 1 до 6 (5) |
| `--no-questions` | без уточняющих вопросов автору |
| `--no-verify` | без верификатора (по умолчанию он опровергает каждое замечание и сливает дубли) |
| `--no-checklist` | не заполнять чек-лист «Ревью требований» |
| `--format` | формат отчёта, если не по расширению |
| `--also md,json,docx` | доп. форматы рядом с отчётом |
| `--no-pdf` | не класть PDF рядом с отчётом не в PDF |
| `--name` | название документа в отчёте |
| `--no-cache` | не использовать кэш ответов модели |
| `--env FILE` | файл с переменными |
| `-q`/`--quiet`, `--version` | без хода работы; версия агента |

Модель по умолчанию — первая доступная ключу из списка рекомендованных (`PREFERRED_MODELS` в
`packages/core/req_core/llm.py`); фактическая модель всегда записывается в паспорт отчёта. Temperature 0 (где модель
её принимает), структурированный JSON-вывод: нативная JSON Schema провайдера → инструмент → схема в промпте с
проверкой.

## Версия агента в паспорте отчёта

Коммит или тег: при запуске из клона — `git describe`, в Docker — коммит, который образ при сборке сам читает из
каталога `.git` (git в образе не нужен). Переменная `AGENT_VERSION` задаёт версию явно — она нужна только при сборке
из архива без `.git` или из рабочей копии `git worktree`:

```powershell
$env:AGENT_VERSION = git describe --always --dirty; docker compose -p reqcheck-core --profile cli run --rm --build -e GEMINI_API_KEY=ваш-ключ cli /data/requirements.md /data/report.pdf
```

```bash
AGENT_VERSION=$(git describe --always --dirty) docker compose -p reqcheck-core --profile cli run --rm --build -e GEMINI_API_KEY=ваш-ключ cli /data/requirements.md /data/report.pdf
```

## Замер полноты

`packages/core/eval/recall.py` + эталон `packages/core/eval/requirements_md_reference.json` для
`samples/requirements.md` (эталон в промптах не используется).
