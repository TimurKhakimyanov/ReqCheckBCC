"""CLI агента: одна команда — путь к документу требований и путь к отчёту.

    python -m req_core.cli samples/requirements.md reports/report.md
    python -m req_core.cli doc.pdf report.docx --provider openai --model gpt-6.2-sol --verify

Ключ LLM берётся из окружения или файла .env (GEMINI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY,
OPENAI_COMPATIBLE_BASE_URL/OPENAI_COMPATIBLE_API_KEY/OPENAI_COMPATIBLE_MODEL).
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from pathlib import Path

from req_contracts import ProgressEvent, ProviderConfig, ProviderName, ValidationOptions

FORMATS = ("md", "json", "docx", "pdf")


def _load_dotenv() -> None:
    try:
        from dotenv import find_dotenv, load_dotenv
    except ImportError:  # pragma: no cover
        return
    path = find_dotenv(usecwd=True)
    if path:
        load_dotenv(path, override=False)


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
    p.add_argument("--verify", action="store_true", help="второй проход-критик перепроверяет дефекты")
    p.add_argument("--no-split", action="store_true", help="не выделять атомарные подтребования составных")
    p.add_argument("--no-checklist", action="store_true", help="не заполнять чек-лист «Ревью требований»")
    p.add_argument("--base-url", default=None, help="base_url для openai_compatible (Ollama, vLLM)")
    p.add_argument("--name", default=None, help="название документа в отчёте (по умолчанию имя файла)")
    p.add_argument("-q", "--quiet", action="store_true", help="без прогресса в stderr")
    return p


def _provider_config(args: argparse.Namespace) -> ProviderConfig | None:
    name = (args.provider or os.environ.get("LLM_PROVIDER") or "gemini").strip().lower()
    if name == "fake":
        return None
    try:
        provider = ProviderName(name)
    except ValueError:
        raise SystemExit(f"Неизвестный провайдер: {name}. Допустимо: {', '.join(p.value for p in ProviderName)}")
    model = args.model
    if model is None and (args.provider is None or args.provider == os.environ.get("LLM_PROVIDER")):
        model = os.environ.get("LLM_MODEL") or None
    if model is None and provider == ProviderName.OPENAI_COMPATIBLE:
        model = os.environ.get("OPENAI_COMPATIBLE_MODEL") or None
    base_url = args.base_url or (os.environ.get("OPENAI_COMPATIBLE_BASE_URL") if provider == ProviderName.OPENAI_COMPATIBLE else None)
    return ProviderConfig(provider=provider, model=model or "", base_url=base_url)


def main(argv: list[str] | None = None) -> int:
    _load_dotenv()
    args = build_parser().parse_args(argv)
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "WARNING").upper(), stream=sys.stderr,
                        format="%(levelname)s %(name)s: %(message)s")
    fmt = args.format or args.output.suffix.lower().lstrip(".")
    if fmt not in FORMATS:
        print(f"Не удалось определить формат отчёта по «{args.output.name}»; укажите --format {{{','.join(FORMATS)}}}",
              file=sys.stderr)
        return 2
    extra = [f.strip() for f in args.also.split(",") if f.strip()]
    bad = [f for f in extra if f not in FORMATS]
    if bad:
        print(f"Неизвестные форматы в --also: {', '.join(bad)}", file=sys.stderr)
        return 2
    if not args.input.is_file():
        print(f"Файл не найден: {args.input}", file=sys.stderr)
        return 2

    from . import parse_document, render_report
    from .pipeline import run_pipeline

    options = ValidationOptions(verify_pass=args.verify, split_compound=not args.no_split,
                                fill_checklist=not args.no_checklist)

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
