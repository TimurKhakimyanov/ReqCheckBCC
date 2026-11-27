"""Командная строка, как в bbc-agent: одна команда — документ требований на входе, отчёт на выходе.

    python run.py examples/requirements.pdf reports/report.pdf
    python run.py doc.pdf reports/report.md --ask                       # вопросы автору в консоли
    python run.py doc.pdf reports/report.md --answers reports/report.questions.json
    python -m req_core.cli doc.docx report.docx --provider openai --model gpt-6.2-sol

Настройки модели — как в bbc-agent: файл .env рядом (или --env FILE) и переменные окружения
(LLM_PROVIDER, OPENAI_BASE_URL, OPENAI_MODEL, OPENAI_API_KEY, GEMINI_API_KEY, GEMINI_MODEL, OLLAMA_BASE_URL,
OLLAMA_MODEL, LLM_CONCURRENCY, LLM_MAX_TOKENS, LLM_TIMEOUT, LLM_MIN_INTERVAL, LLM_MAX_RETRIES, LLM_TEMPERATURE,
AGENT_BATCH_SIZE, LLM_CONTEXT_TOKENS, LLM_EXTRA_BODY, LLM_EXTRA_BODY_REVIEWER, LLM_CACHE_DIR). Флаги важнее
переменных. LLM_PROVIDER=openai с адресом не api.openai.com — любой OpenAI-совместимый сервер (vLLM, LM Studio).
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from pathlib import Path

from pydantic import SecretStr
from req_contracts import ProgressEvent, ProviderConfig, ProviderName, ValidationOptions

FORMATS = ("md", "json", "docx", "pdf")
KEY_ENV: dict[ProviderName, tuple[str, ...]] = {
    ProviderName.GEMINI: ("GEMINI_API_KEY", "GOOGLE_API_KEY"),
    ProviderName.OPENAI: ("OPENAI_API_KEY",),
    ProviderName.ANTHROPIC: ("ANTHROPIC_API_KEY",),
    ProviderName.OPENAI_COMPATIBLE: ("OPENAI_COMPATIBLE_API_KEY", "OPENAI_API_KEY"),
}
DEFAULT_CACHE_DIR = ".cache/llm"
# Переменные bbc-agent, которых в Zoe нет: о них предупреждаем, а не молча игнорируем.
ROLES = ("extractor", "inspector", "reviewer", "verifier", "clarifier", "reporter")


def _json_obj(s: str) -> dict:
    try:
        v = json.loads(s)
    except json.JSONDecodeError as e:
        raise argparse.ArgumentTypeError(f"некорректный JSON: {e}") from e
    if not isinstance(v, dict):
        raise argparse.ArgumentTypeError("ожидается JSON-объект {…}")
    return v


def _version() -> str:
    from .version import agent_version

    return agent_version()


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="python run.py",
        description="Zoe — ИИ-агент статической проверки требований: читает документ, проверяет каждое требование и "
                    "набор целиком по ISO/IEC/IEEE 29148 и IEEE 830, задаёт уточняющие вопросы и пишет отчёт.",
    )
    p.add_argument("input", type=Path, help="путь к файлу требований (.pdf, .md, .docx, .txt)")
    p.add_argument("output", type=Path, help="путь к файлу отчёта (формат по расширению: .pdf, .md, .json, .docx)")
    # как в bbc-agent
    p.add_argument("--ask", action="store_true", help="задать уточняющие вопросы в консоли и учесть ответы в отчёте")
    p.add_argument("--answers", type=Path, default=None, metavar="FILE",
                   help="файл с ответами на вопросы: <отчёт>.questions.json прошлого прогона с заполненным полем answer "
                        "или JSON {\"Q-01\": \"ответ\"} — агент предложит новые редакции требований")
    p.add_argument("--max-questions", type=int, default=5, choices=range(1, 7), metavar="1–6",
                   help="максимум уточняющих вопросов: от 1 до 6 (по умолчанию 5)")
    p.add_argument("--no-cache", action="store_true", help="не использовать кэш ответов модели")
    p.add_argument("--env", type=Path, default=None, metavar="FILE",
                   help="файл с переменными окружения (по умолчанию .env в текущей папке, если он есть)")
    p.add_argument("-q", "--quiet", action="store_true", help="не печатать ход работы")
    p.add_argument("--version", action="version", version=f"Zoe {_version()}", help="показать версию агента и выйти")
    # модель и провайдер (важнее переменных окружения)
    p.add_argument("--provider", default=None,
                   help="gemini | openai | anthropic | openai_compatible | ollama (по умолчанию LLM_PROVIDER)")
    p.add_argument("--model", default=None, help="id модели (по умолчанию из .env: OPENAI_MODEL, GEMINI_MODEL…)")
    p.add_argument("--api-key", default=None, help="ключ провайдера (иначе — из .env / переменных окружения)")
    p.add_argument("--base-url", default=None, help="адрес API OpenAI-совместимого сервера (vLLM, Ollama: …/v1)")
    p.add_argument("--max-tokens", "--max-output-tokens", dest="max_output_tokens", type=int, default=None,
                   help="лимит ответа модели, токенов (LLM_MAX_TOKENS; для рассуждающих моделей включает размышления)")
    p.add_argument("--timeout", type=float, default=None, help="таймаут одного вызова, с (LLM_TIMEOUT, по умолчанию 600)")
    p.add_argument("--concurrency", type=int, default=None,
                   help="параллельных вызовов (LLM_CONCURRENCY): локальный сервер — 8, бесплатный Gemini — 1")
    p.add_argument("--batch-size", type=int, default=None, help="требований на вызов инспектора (AGENT_BATCH_SIZE, 5)")
    p.add_argument("--min-interval", type=float, default=None, help="пауза между вызовами, с (LLM_MIN_INTERVAL)")
    p.add_argument("--max-attempts", type=int, default=None, help="попыток на вызов при 429/5xx (LLM_MAX_RETRIES + 1)")
    p.add_argument("--context-tokens", type=int, default=None,
                   help="окно модели в токенах (LLM_CONTEXT_TOKENS); по умолчанию его сообщает сервер")
    p.add_argument("--extra-body", type=_json_obj, default=None,
                   help='доп. поля запроса (LLM_EXTRA_BODY), напр. \'{"chat_template_kwargs":{"enable_thinking":false}}\'')
    p.add_argument("--extra-body-set-review", type=_json_obj, default=None,
                   help="доп. поля запроса рецензентов набора (LLM_EXTRA_BODY_REVIEWER)")
    # отчёт
    p.add_argument("--format", choices=FORMATS, default=None, help="формат отчёта, если не по расширению")
    p.add_argument("--also", default="", help="доп. форматы рядом с отчётом через запятую, напр. json,docx")
    p.add_argument("--no-pdf", action="store_true", help="не класть PDF рядом с отчётом (по умолчанию PDF создаётся)")
    p.add_argument("--no-verify", action="store_true", help="без верификатора (по умолчанию он перепроверяет замечания)")
    p.add_argument("--verify", action="store_true", help=argparse.SUPPRESS)  # совместимость: верификатор и так включён
    p.add_argument("--no-questions", action="store_true", help="без уточняющих вопросов автору документа")
    p.add_argument("--no-checklist", action="store_true", help="не заполнять чек-лист «Ревью требований»")
    p.add_argument("--no-split", action="store_true", help=argparse.SUPPRESS)  # совместимость
    p.add_argument("--name", default=None, help="название документа в отчёте (по умолчанию имя файла)")
    return p


def load_env_file(path: Path) -> int:
    """Переменные из файла .env (KEY=VALUE, # комментарии). Как load_dotenv(override=False) в bbc-agent:
    уже заданные в окружении переменные важнее файла. Возвращает число загруженных переменных."""
    n = 0
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        s = line.strip()
        if not s or s.startswith("#") or "=" not in s:
            continue
        if s.startswith("export "):
            s = s[7:].lstrip()
        key, val = (x.strip() for x in s.split("=", 1))
        if len(val) >= 2 and val[0] in "\"'" and val[-1] == val[0]:
            val = val[1:-1]
        else:
            val = val.split(" #", 1)[0].rstrip()
        if key and key not in os.environ:
            os.environ[key] = val
            n += 1
    return n


def load_answers(path: Path) -> dict[str, str]:
    """Ответы автора: {"Q-01": "ответ"} или [{"id": "Q-01", "answer": "…"}] (файл <отчёт>.questions.json)."""
    raw = json.loads(path.read_text(encoding="utf-8"))
    rows = raw.items() if isinstance(raw, dict) else [(r.get("id"), r) for r in raw if isinstance(r, dict)]
    out: dict[str, str] = {}
    for key, val in rows:
        ans = val.get("answer") if isinstance(val, dict) else val
        if key and isinstance(ans, str) and ans.strip():
            out[str(key).strip()] = ans.strip()
    return out


def _num(env: str, cast: type, flag: float | int | None = None) -> float | int | None:
    if flag is not None:
        return flag
    raw = (os.environ.get(env) or "").strip()
    if not raw:
        return None
    try:
        return cast(raw)
    except ValueError:
        raise SystemExit(f"Переменная {env} должна быть числом, а не «{raw}»") from None


def _json_env(env: str, flag: dict | None = None) -> dict | None:
    if flag is not None:
        return flag
    raw = (os.environ.get(env) or "").strip()
    if not raw:
        return None
    try:
        return _json_obj(raw)
    except argparse.ArgumentTypeError as e:
        raise SystemExit(f"Переменная {env} должна содержать JSON-объект: {e}") from None


def _provider_config(args: argparse.Namespace) -> ProviderConfig | None:
    """Конфиг провайдера: флаги, затем .env / переменные окружения (имена — как в bbc-agent)."""
    env = os.environ
    name = (args.provider or env.get("LLM_PROVIDER") or "").strip().lower()
    if not name:  # как load_config в bbc-agent: по найденному ключу или адресу
        if env.get("GEMINI_API_KEY"):
            name = "gemini"
        elif env.get("OPENAI_COMPATIBLE_BASE_URL"):
            name = "openai_compatible"
        elif env.get("OPENAI_BASE_URL") or env.get("OPENAI_API_KEY"):
            name = "openai"
        elif env.get("OLLAMA_BASE_URL"):
            name = "ollama"
        else:
            name = "gemini"
    if name == "fake":
        return None
    model = args.model or env.get("LLM_MODEL")
    base_url = args.base_url
    key = args.api_key
    if name == "ollama":
        base = (base_url or env.get("OLLAMA_BASE_URL") or "http://localhost:11434").rstrip("/")
        name, base_url, model = "openai_compatible", base if base.endswith("/v1") else base + "/v1", model or env.get("OLLAMA_MODEL")
    elif name == "openai":
        # в bbc-agent «openai» — любой OpenAI-совместимый сервер; api.openai.com — сам OpenAI
        url = (base_url or env.get("OPENAI_BASE_URL") or "").rstrip("/")
        if url and "api.openai.com" not in url:
            name, base_url = "openai_compatible", url
        model = model or env.get("OPENAI_MODEL")
    try:
        provider = ProviderName(name)
    except ValueError:
        raise SystemExit(f"Неизвестный провайдер: {name}. Допустимо: {', '.join(p.value for p in ProviderName)}, ollama")
    if provider == ProviderName.OPENAI_COMPATIBLE:
        base_url = base_url or env.get("OPENAI_COMPATIBLE_BASE_URL") or (env.get("OPENAI_BASE_URL") or "").rstrip("/") or None
        model = model or env.get("OPENAI_COMPATIBLE_MODEL") or env.get("OPENAI_MODEL")
    elif provider == ProviderName.GEMINI:
        model = model or env.get("GEMINI_MODEL")
    elif provider == ProviderName.OPENAI:
        model = model or env.get("OPENAI_MODEL")
    elif provider == ProviderName.ANTHROPIC:
        model = model or env.get("ANTHROPIC_MODEL")
    key = key or next((env[k] for k in KEY_ENV[provider] if env.get(k)), None)
    retries = _num("LLM_MAX_RETRIES", int)
    extra = {k: v for k, v in {
        "temperature": _num("LLM_TEMPERATURE", float),
        "max_output_tokens": _num("LLM_MAX_TOKENS", int, args.max_output_tokens),
        "timeout_s": _num("LLM_TIMEOUT", float, args.timeout),
        "min_interval_s": _num("LLM_MIN_INTERVAL", float, args.min_interval),
        "max_attempts": args.max_attempts if args.max_attempts is not None else (retries + 1 if retries is not None else None),
        "context_tokens": _num("LLM_CONTEXT_TOKENS", int, args.context_tokens) or None,
        "extra_body": _json_env("LLM_EXTRA_BODY", args.extra_body),
        "extra_body_set_review": _json_env("LLM_EXTRA_BODY_REVIEWER", args.extra_body_set_review),
    }.items() if v is not None}
    return ProviderConfig(provider=provider, model=model or "", base_url=base_url or None,
                          api_key=SecretStr(key) if key else None, **extra)


def _warn_unsupported(quiet: bool) -> None:
    """Своя модель, лимит или параметры запроса для отдельной роли (кроме рецензентов) и запасные параметры
    при обрыве ответа — в Zoe не поддерживаются: говорим об этом, а не молча игнорируем."""
    names = sorted(
        k for k, v in os.environ.items() if v.strip() and (
            (k.startswith("MODEL_") and k[6:].lower() in ROLES)
            or (k.startswith("LLM_MAX_TOKENS_") and k[15:].lower() in ROLES)
            or (k.startswith("LLM_EXTRA_BODY_") and k[15:].lower() in ROLES and k != "LLM_EXTRA_BODY_REVIEWER")
            or k == "LLM_TRUNCATION_FALLBACK_BODY"
        )
    )
    if names and not quiet:
        print(f"Внимание: эти переменные bbc-agent в Zoe не поддерживаются и не учитываются: {', '.join(names)}",
              file=sys.stderr)


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")  # кириллица в консоли Windows
        except (AttributeError, ValueError):
            pass
    args = build_parser().parse_args(argv)
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "WARNING").upper(), stream=sys.stderr,
                        format="%(levelname)s %(name)s: %(message)s")
    env_file = args.env or Path(".env")
    if args.env is not None and not env_file.is_file():
        print(f"Файл не найден: {env_file}", file=sys.stderr)
        return 2
    if env_file.is_file():
        load_env_file(env_file)
    _warn_unsupported(args.quiet)

    if not args.format and not args.output.suffix:  # без расширения — итоговый PDF-отчёт
        args.output = args.output.with_suffix(".pdf")
    fmt = args.format or args.output.suffix.lower().lstrip(".")
    if fmt not in FORMATS:
        print(f"Не удалось определить формат отчёта по «{args.output.name}»; укажите --format {{{','.join(FORMATS)}}}",
              file=sys.stderr)
        return 2
    extra = [f.strip() for f in args.also.split(",") if f.strip()]
    if fmt != "pdf" and not args.no_pdf and "pdf" not in extra:
        extra.append("pdf")  # итоговый PDF-отчёт — всегда, сразу после прогона
    bad = [f for f in extra if f not in FORMATS]
    if bad:
        print(f"Неизвестные форматы в --also: {', '.join(bad)}", file=sys.stderr)
        return 2
    if not args.input.is_file():
        print(f"Файл не найден: {args.input}", file=sys.stderr)
        return 2

    from . import parse_document, render_report
    from .pipeline import run_pipeline

    opt_extra = {k: v for k, v in {"batch_size": _num("AGENT_BATCH_SIZE", int, args.batch_size),
                                   "concurrency": _num("LLM_CONCURRENCY", int, args.concurrency),
                                   "max_questions": args.max_questions}.items() if v is not None}
    if args.answers is not None:
        try:
            opt_extra["answers"] = load_answers(args.answers)
        except (OSError, ValueError) as e:
            print(f"Не удалось прочитать ответы {args.answers}: {e}", file=sys.stderr)
            return 2
    options = ValidationOptions(verify_pass=not args.no_verify, split_compound=not args.no_split,
                                fill_checklist=not args.no_checklist, ask_questions=not args.no_questions,
                                **opt_extra)

    def on_progress(ev: ProgressEvent) -> None:
        if args.quiet:
            return
        step = f" {ev.current}/{ev.total}" if ev.current is not None and ev.total else ""
        print(f"[{ev.progress * 100:5.1f}%] {ev.message}{step}", file=sys.stderr, flush=True)

    saved_cache = os.environ.get("LLM_CACHE_DIR")
    try:
        cfg = _provider_config(args)
        # кэш ответов модели, как в bbc-agent (.cache/llm); только на время этого прогона и не для тестовой модели
        if cfg is None or args.no_cache:
            os.environ.pop("LLM_CACHE_DIR", None)
        elif not saved_cache:
            os.environ["LLM_CACHE_DIR"] = DEFAULT_CACHE_DIR
        doc = parse_document(args.input, name=args.name)
        if cfg is None:
            from .testing import FakeLLM

            client, provider = FakeLLM(), "fake"
        else:
            from . import get_llm

            client, provider = get_llm(cfg), cfg.provider.value
        if not args.quiet:
            par = f"; параллельно: {options.concurrency}; пакет: {options.batch_size}"
            print(f"Документ: {doc.name} ({doc.format.value}, {len(doc.text)} символов); "
                  f"модель: {provider}/{client.model}{par}", file=sys.stderr)
        report = run_pipeline(doc, client, options=options, on_progress=on_progress, provider=provider,
                              model=client.model, interactive=args.ask)
    except KeyboardInterrupt:
        print("\nПрервано.", file=sys.stderr)
        return 130
    except Exception as e:  # noqa: BLE001 — понятное сообщение вместо трассировки
        logging.getLogger("req_core.cli").debug("ошибка прогона", exc_info=True)
        print(f"Ошибка: {type(e).__name__}: {e}", file=sys.stderr)
        return 1
    finally:
        if saved_cache is None:
            os.environ.pop("LLM_CACHE_DIR", None)
        else:
            os.environ["LLM_CACHE_DIR"] = saved_cache

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(render_report(report, fmt))
    written = [args.output]
    for f in extra:
        if f == fmt:
            continue
        path = args.output.with_suffix("." + f)
        path.write_bytes(render_report(report, f))
        written.append(path)
    qpath = None
    if report.questions:  # вопросы автору — сюда вписываются ответы для повторного прогона с --answers
        qpath = args.output.with_suffix(".questions.json")
        qpath.write_text(json.dumps(
            [{"id": q.id, "priority": q.priority.value, "addressee": q.addressee, "question": q.question,
              "options": q.options, "answer": q.answer or ""} for q in report.questions],
            ensure_ascii=False, indent=1), encoding="utf-8")
    s = report.summary
    if not args.quiet:
        u = report.usage
        print(f"\nГотово. Требований: {s.requirements_total}, нарушений: {s.findings_total} "
              f"(критичных: {len(s.critical_finding_ids)}), вопросов автору: {len(report.questions or [])}. "
              f"Разработка: {'можно' if report.conclusion.ready_for_development else 'нельзя'}.", file=sys.stderr)
        print(f"Токены: вход {u.prompt_tokens}, выход {u.completion_tokens}; вызовов модели: {u.llm_calls}"
              + (f"; длительность: {u.duration_s:.0f} с" if u.duration_s else "") + ".", file=sys.stderr)
    for w in written:
        print(f"Отчёт:   {w}", file=sys.stderr)
    if qpath is not None:
        print(f"Вопросы: {qpath}  (впишите ответы в поле answer и запустите с --answers)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
