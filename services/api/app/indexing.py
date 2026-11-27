"""Индексация требований и дефектов отчёта в Qdrant (коллекция requirements) для поиска похожих."""

from __future__ import annotations

from req_contracts import Report

from .vectors import REQUIREMENTS, VectorStore, point_id


def report_points(run_id: str, document_id: str, document_name: str, report: Report) -> list[tuple[str, str, dict]]:
    base = {"run_id": run_id, "document_id": document_id, "document_name": document_name}
    items: list[tuple[str, str, dict]] = []
    for r in report.requirements:
        label = f"{r.source_id}. " if r.source_id else ""
        text = f"{label}{r.location.quote or r.summary}".strip()
        items.append((point_id(run_id, "requirement", r.id), text,
                      {**base, "kind": "requirement", "requirement_id": r.id, "summary": r.summary}))
    for f in report.findings:
        quote = f.locations[0].quote if f.locations else ""
        text = f"{f.title}. {f.explanation} Цитата: «{quote}»"
        items.append((point_id(run_id, "finding", f.id), text,
                      {**base, "kind": "finding", "finding_id": f.id, "criterion": f.criterion.value,
                       "severity": f.severity.value, "requirement_ids": f.requirement_ids}))
    return items


def index_report(vectors: VectorStore, run_id: str, document_id: str, document_name: str, report: Report) -> int:
    vectors.delete_where(REQUIREMENTS, "run_id", run_id)
    return vectors.upsert(REQUIREMENTS, report_points(run_id, document_id, document_name, report))
