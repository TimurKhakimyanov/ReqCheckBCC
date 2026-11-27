"""Чат по отчёту: потоковый ответ модели с контекстом отчёта и документа."""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

from req_contracts import Report

from .prompts import CHAT_SYSTEM
from .render import KIND_RU, SEV_RU

CHAT_DOC_CHARS = 60_000


def report_context(report: Report, doc_limit: int | None = None) -> str:
    doc_limit = doc_limit or CHAT_DOC_CHARS
    p, s, c = report.passport, report.summary, report.conclusion
    lines = [
        f"Документ: {p.document_name}; модель проверки: {p.provider}/{p.model}; дата: {p.run_at:%d.%m.%Y}.",
        f"Требований: {s.requirements_total}; дефектов: {s.findings_total} "
        f"(критичных {len(s.critical_finding_ids)}).",
        f"Итог: разработка — {'да' if c.ready_for_development else 'нет'}, "
        f"тестирование — {'да' if c.ready_for_testing else 'нет'}. {c.rationale}",
        "", "Требования:",
    ]
    for r in report.requirements:
        lines.append(f"- {r.id} ({r.source_id or 'без номера'}, {KIND_RU[r.kind]}"
                     f"{', часть ' + r.parent_id if r.parent_id else ''}): {r.summary}")
    lines += ["", "Дефекты:"]
    for f in report.findings:
        q = f.locations[0].quote if f.locations else ""
        lines.append(f"- {f.id} [{SEV_RU[f.severity]}, {f.criterion.value}, {', '.join(f.requirement_ids) or 'набор'}] "
                     f"{f.title}. {f.explanation} Цитата: «{' '.join(q.split())[:300]}»."
                     + (f" Исправление: {f.suggestion}" if f.suggestion else ""))
    text = report.document.text
    if len(text) > doc_limit:
        text = text[:doc_limit] + "\n[… обрезано …]"
    lines += ["", "<document>", text, "</document>"]
    return "\n".join(lines)


def answer_stream(client: Any, report: Report, history: list[Any], question: str,
                  knowledge_snippets: list[str] | None = None) -> Iterator[str]:
    system = CHAT_SYSTEM + "\n\n# Отчёт\n" + report_context(report)
    if knowledge_snippets:
        system += "\n\n# База знаний\n" + "\n".join(f"- {k}" for k in knowledge_snippets if k.strip())
    msgs = [m for m in history if (m["role"] if isinstance(m, dict) else m.role) in ("user", "assistant")]
    msgs = msgs[-20:] + [{"role": "user", "content": question}]
    yield from client.stream(system, msgs)
