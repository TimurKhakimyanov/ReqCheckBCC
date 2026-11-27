"""CLI агента: одна команда — путь к документу требований и путь к отчёту.

    python -m req_core.cli samples/requirements.md reports/report.md
    python -m req_core.cli doc.pdf report.docx --provider openai --model gpt-6.2-sol

Ключ и параметры LLM передаются при запуске: флагами (--api-key, --base-url, --model …) или переменными
окружения процесса (GEMINI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, OPENAI_COMPATIBLE_API_KEY,
OPENAI_COMPATIBLE_BASE_URL, LLM_PROVIDER, LLM_MODEL). Файл .env для LLM не читается.
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
    ProviderName.OPENAI_COMPATIBLE: ("OPENAI_COMPATIBLE_API_KEY",),
}


def _json_obj(s: str) -> dict:
    try:
        v = json.loads(s)
    except json.JSONDecodeError as e:
        raise argparse.ArgumentTypeError(f"некорректный JSON: {e}") from e
    if not isinstance(v, dict):
        raise argparse.ArgumentTypeError("ожидается JSON-объект {…}")
    return v


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="python -m req_core.cli",
        description="ReqCheck: статическая проверка документа требований (ISO/IEC/IEEE 29148, IEEE 830).",
    )
    p.add_argument("input", type=Path, help="документ требований: PDF, DOCX, MD или TXT")
    p.add_argument("output", type=Path, help="файл отчёта (формат по расширению: .md, .json, .docx, .pdf)")
    p.add_argument("--provider", default=None,
                   help="gemini | openai | anthropic | openai_compatible (по умолчанию LLM_PROVIDER или gemini)")
    p.add_argument("--model", default=None, help="id модели (по умолчанию LLM_MODEL или рекомендуемая модель)")
    p.add_argument("--format", choices=FORMATS, default=None, help="формат отчёта, если не по расширению")
    p.add_argument("--also", default="", help="доп. форматы рядом с отчётом через запятую, напр. json,docx")
    p.add_argument("--no-pdf", action="store_true",
                   help="не класть PDF рядом с отчётом (по умолчанию PDF создаётся всегда)")
    p.add_argument("--no-verify", action="store_true",
                   help="без верификатора (по умолчанию он опровергает каждый дефект и сливает дубли)")
    p.add_argument("--verify", action="store_true", help=argparse.SUPPRESS)  # совместимость: верификатор и так включён
    p.add_argument("--no-questions", action="store_true", help="без уточняющих вопросов автору документа")
    p.add_argument("--max-questions", type=int, default=None, help="не больше стольких вопросов (по умолчанию 15)")
    p.add_argument("--no-split", action="store_true", help=argparse.SUPPRESS)  # совместимость: составные не делятся
    p.add_argument("--answers", type=Path, default=None,
                   help="ответы автора на уточняющие вопросы: JSON {\"Q-01\": \"ответ\"} или файл <отчёт>.questions.json "
                        "с заполненным полем answer — агент предложит новые редакции требований")
    p.add_argument("--context-tokens", type=int, default=None,
                   help="окно модели в токенах (по умолчанию — оценка по провайдеру; для vLLM укажите max_model_len)")
    p.add_argument("--no-checklist", action="store_true", help="не заполнять чек-лист «Ревью требований»")
    p.add_argument("--api-key", default=None, help="ключ провайдера (иначе — переменная окружения провайдера)")
    p.add_argument("--base-url", default=None, help="адрес API: обязателен для openai_compatible (vLLM, Ollama: …/v1)")
    p.add_argument("--max-tokens", "--max-output-tokens", dest="max_output_tokens", type=int, default=None,
                   help="лимит ответа модели, токенов (по умолчанию — с запасом)")
    p.add_argument("--extra-body", type=_json_obj, default=None,
                   help='доп. поля тела запроса (JSON), напр. \'{"chat_template_kwargs":{"enable_thinking":false}}\'')
    p.add_argument("--extra-body-set-review", type=_json_obj, default=None,
                   help="extra_body для проверки набора (JSON); по умолчанию — как --extra-body")
    p.add_argument("--timeout", type=float, default=None, help="таймаут запроса, с (по умолчанию 180)")
    p.add_argument("--min-interval", type=float, default=None, help="пауза между запросами, с (бесплатные тарифы)")
    p.add_argument("--max-attempts", type=int, default=None, help="попыток на запрос при 429/5xx (по умолчанию 6)")
    p.add_argument("--batch-size", type=int, default=None, help="требований в одном запросе (по умолчанию 6)")
    p.add_argument("--concurrency", type=int, default=None, help="параллельных запросов (по умолчанию 1)")
    p.add_argument("--name", default=None, help="название документа в отчёте (по умолчанию имя файла)")
    p.add_argument("-q", "--quiet", action="store_true", help="без прогресса в stderr")
    return p


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


def _provider_config(args: argparse.Namespace) -> ProviderConfig | None:
    """Конфиг провайдера из флагов; чего нет во флагах — из переменных окружения процесса."""
    env = os.environ
    name = (args.provider or env.get("LLM_PROVIDER") or "gemini").strip().lower()
    if name == "fake":
        return None
    try:
        provider = ProviderName(name)
    except ValueError:
        raise SystemExit(f"Неизвестный провайдер: {name}. Допустимо: {', '.join(p.value for p in ProviderName)}")
    same_as_env = args.provider is None or args.provider == env.get("LLM_PROVIDER")
    model = args.model or (env.get("LLM_MODEL") if same_as_env else None)
    if not model and provider == ProviderName.OPENAI_COMPATIBLE:
        model = env.get("OPENAI_COMPATIBLE_MODEL")
    key = args.api_key or next((env[k] for k in KEY_ENV[provider] if env.get(k)), None)
    base_url = args.base_url or (env.get("OPENAI_COMPATIBLE_BASE_URL") if provider == ProviderName.OPENAI_COMPATIBLE
                                 else None)
    extra = {k: v for k, v in {
        "max_output_tokens": args.max_output_tokens, "timeout_s": args.timeout,
        "min_interval_s": args.min_interval, "max_attempts": args.max_attempts,
        "extra_body": args.extra_body, "extra_body_set_review": args.extra_body_set_review,
        "context_tokens": args.context_tokens,
    }.items() if v is not None}
    return ProviderConfig(provider=provider, model=model or "", base_url=base_url or None,
                          api_key=SecretStr(key) if key else None, **extra)


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "WARNING").upper(), stream=sys.stderr,
                        format="%(levelname)s %(name)s: %(message)s")
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

    opt_extra = {k: v for k, v in {"batch_size": args.batch_size, "concurrency": args.concurrency,
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

    try:
        cfg = _provider_config(args)
        doc = parse_document(args.input, name=args.name)
        if cfg is None:
            from .testing import FakeLLM

            client, provider = FakeLLM(), "fake"
        else:
            from . import get_llm

            client, provider = get_llm(cfg), cfg.provider.value
        if not args.quiet:
            print(f"Документ: {doc.name} ({doc.format.value}, {len(doc.text)} символов); "
                  f"модель: {provider}/{client.model}", file=sys.stderr)
        report = run_pipeline(doc, client, options=options, on_progress=on_progress, provider=provider,
                              model=client.model)
    except Exception as e:  # noqa: BLE001 — понятное сообщение вместо трассировки
        logging.getLogger("req_core.cli").debug("ошибка прогона", exc_info=True)
        print(f"Ошибка: {type(e).__name__}: {e}", file=sys.stderr)
        return 1

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(render_report(report, fmt))
    written = [args.output]
    for f in extra:
        if f == fmt:
            continue
        path = args.output.with_suffix("." + f)
        path.write_bytes(render_report(report, f))
        written.append(path)
    if report.questions:  # вопросы автору — сюда вписываются ответы для повторного прогона с --answers
        qpath = args.output.with_suffix(".questions.json")
        qpath.write_text(json.dumps(
            [{"id": q.id, "priority": q.priority.value, "addressee": q.addressee, "question": q.question,
              "options": q.options, "answer": q.answer or ""} for q in report.questions],
            ensure_ascii=False, indent=1), encoding="utf-8")
        written.append(qpath)
    s = report.summary
    if not args.quiet:
        print(f"Требований: {s.requirements_total}; дефектов: {s.findings_total} "
              f"(критичных {len(s.critical_finding_ids)}). "
              f"Разработка: {'можно' if report.conclusion.ready_for_development else 'нельзя'}; "
              f"токенов: {report.usage.prompt_tokens}+{report.usage.completion_tokens}.", file=sys.stderr)
    for w in written:
        print(f"Отчёт: {w}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
