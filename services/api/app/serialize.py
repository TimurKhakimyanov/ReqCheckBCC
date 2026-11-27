"""Преобразование строк БД в ответы API."""

from __future__ import annotations

from req_contracts import Report, RunStage, Usage

from .models import ChatMessageRow, Document, Run
from .schemas import ChatMessageOut, DocumentOut, RunOut, RunShort, RunSummary

TERMINAL = {RunStage.DONE.value, RunStage.FAILED.value, RunStage.CANCELLED.value}


def summary_from_report(report: Report) -> dict:
    """То, что хранится в runs.summary: сводка отчёта + итог готовности."""
    return RunSummary(**report.summary.model_dump(), ready_for_development=report.conclusion.ready_for_development,
                      ready_for_testing=report.conclusion.ready_for_testing).model_dump(mode="json")


def _summary(run: Run) -> RunSummary | None:
    return RunSummary.model_validate(run.summary) if run.summary else None


def run_out(run: Run, document_name: str | None = None) -> RunOut:
    return RunOut(
        id=str(run.id), document_id=str(run.document_id),
        document_name=document_name if document_name is not None else run.document.name,
        status=RunStage(run.status), stage=RunStage(run.stage), progress=run.progress, message=run.message or "",
        provider=run.provider, model=run.model, options=run.options or {}, created_at=run.created_at,
        started_at=run.started_at, finished_at=run.finished_at, error=run.error,
        usage=Usage.model_validate(run.usage) if run.usage else None, summary=_summary(run),
    )


def run_short(run: Run) -> RunShort:
    return RunShort(id=str(run.id), status=RunStage(run.status), progress=run.progress, created_at=run.created_at,
                    finished_at=run.finished_at, summary=_summary(run))


def document_out(doc: Document, runs_count: int, last_run: Run | None) -> DocumentOut:
    return DocumentOut(id=str(doc.id), name=doc.name, format=doc.format, size_bytes=doc.size_bytes, sha256=doc.sha256,
                       created_at=doc.created_at, runs_count=runs_count,
                       last_run=run_short(last_run) if last_run else None)


def chat_out(m: ChatMessageRow) -> ChatMessageOut:
    return ChatMessageOut(id=str(m.id), role=m.role, content=m.content, created_at=m.created_at)  # type: ignore[arg-type]
