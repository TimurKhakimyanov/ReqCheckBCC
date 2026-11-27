"""Задача reqcheck.run_validation: документ из S3 → ядро агента → отчёт в Postgres/S3 → индекс в Qdrant."""

from __future__ import annotations

import logging
import tempfile
import threading
import time
import uuid
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from datetime import datetime, timezone
from pathlib import Path

import req_core
from app.app_settings import read_app_settings
from app.db import SessionLocal
from app.indexing import index_report
from app.models import Document, ReportRow, Run
from app.providers import ProviderNotConfigured, build_provider_config
from app.serialize import summary_from_report
from app.services import TASK_RUN_VALIDATION, Services, get_services, run_cancel_key, run_events_channel
from app.vectors import KNOWLEDGE
from req_contracts import ProgressEvent, Report, RunStage, ValidationOptions

from .celery_app import celery
from .metrics import (
    FINDINGS,
    LLM_COST,
    LLM_REQUESTS,
    LLM_TOKENS,
    RUN_DURATION,
    RUNS_FINISHED,
    RUNS_IN_PROGRESS,
    STAGE_DURATION,
)

log = logging.getLogger("worker.tasks")

TERMINAL = {RunStage.DONE.value, RunStage.FAILED.value, RunStage.CANCELLED.value}
CORE_TERMINAL = {RunStage.DONE, RunStage.FAILED, RunStage.CANCELLED}
EXPORT_FORMATS = {
    "md": "text/markdown; charset=utf-8",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "pdf": "application/pdf",
}
# Доля общего прогресса, отведённая ядру; остальное — выгрузки и индексация.
CORE_START, CORE_END = 0.02, 0.90


class _RunLog(logging.LoggerAdapter):
    """Добавляет run_id, не теряя extra конкретного вызова (merge_extra появился только в 3.13)."""

    def process(self, msg, kwargs):
        kwargs["extra"] = {**(self.extra or {}), **(kwargs.get("extra") or {})}
        return msg, kwargs


class RunCancelled(Exception):
    pass


class RunTimedOut(Exception):
    pass


class Progress:
    """Публикует события в Redis и обновляет строку прогона; бросает RunCancelled, если прогон отменили."""

    def __init__(self, svc: Services, run_id: str):
        self.svc = svc
        self.run_id = run_id
        self.rid = uuid.UUID(run_id)
        self._last_db_write = 0.0
        self._last_stage: str | None = None
        self._last_progress = 0.0
        self._lock = threading.Lock()
        self._stage: str | None = None
        self._stage_started = time.monotonic()

    def _track_stage(self, stage: str) -> None:
        if stage != self._stage:
            self.close_stage()
            self._stage, self._stage_started = stage, time.monotonic()

    def close_stage(self) -> None:
        if self._stage and self._stage not in TERMINAL:
            STAGE_DURATION.labels(self._stage).observe(time.monotonic() - self._stage_started)
        self._stage = None

    def cancelled(self) -> bool:
        try:
            return bool(self.svc.redis.exists(run_cancel_key(self.run_id)))
        except Exception:  # noqa: BLE001
            return False

    def emit(self, stage: RunStage, progress: float, message: str = "", current: int | None = None,
             total: int | None = None, *, force_db: bool = False) -> None:
        with self._lock:
            progress = max(self._last_progress, min(progress, 1.0))  # прогресс не уменьшается
            self._last_progress = progress
            event = ProgressEvent(run_id=self.run_id, stage=stage, progress=round(progress, 4), message=message,
                                  current=current, total=total)
            self._track_stage(stage.value)
            now = time.monotonic()
            write = force_db or stage.value != self._last_stage or now - self._last_db_write > 1.0
            if stage.value not in TERMINAL and write:
                self._last_db_write, self._last_stage = now, stage.value
                with SessionLocal() as db:
                    run = db.get(Run, self.rid)
                    if run is None:
                        raise RunCancelled("run deleted")
                    if run.status == RunStage.CANCELLED.value:
                        raise RunCancelled("run cancelled")
                    run.status = run.stage = stage.value
                    run.progress, run.message = event.progress, message
                    db.commit()
            try:
                self.svc.redis.publish(run_events_channel(self.run_id), event.model_dump_json())
            except Exception:  # noqa: BLE001
                log.warning("redis publish failed", exc_info=True)

    def on_core_progress(self, event: ProgressEvent) -> None:
        """Callback для ядра. Финальные стадии ядра не пересылаются: «done» публикует воркер после сохранения."""
        if self.cancelled():
            raise RunCancelled("run cancelled")
        stage = RunStage.VERIFYING if event.stage in CORE_TERMINAL else event.stage
        self.emit(stage, CORE_START + event.progress * (CORE_END - CORE_START), event.message, event.current,
                  event.total)


def describe_error(exc: BaseException, timeout_s: int) -> str:
    name = type(exc).__name__
    text = str(exc)
    low = f"{name} {text}".lower()
    if isinstance(exc, RunTimedOut):
        return f"Превышено время прогона ({timeout_s} с). Попробуйте более быструю модель или увеличьте RUN_TIMEOUT_S"
    if isinstance(exc, NotImplementedError):
        return "Ядро агента ещё не реализовано в этой сборке (req_core — заглушка)"
    if isinstance(exc, ProviderNotConfigured):
        return text
    if "nosuchkey" in low or "404" in low and "s3" in low:
        return "Исходный файл документа не найден в хранилище"
    if any(s in low for s in ("authentication", "permissiondenied", "invalid api key", "api_key_invalid", "401",
                              "unauthorized")):
        return f"Провайдер LLM отклонил ключ (проверьте ключ в настройках): {text}"[:1000]
    if any(s in low for s in ("ratelimit", "rate limit", "429", "resource_exhausted", "quota")):
        return f"Превышен лимит запросов провайдера LLM (429). Повторите позже: {text}"[:1000]
    if "timeout" in low or "timed out" in low:
        return f"Провайдер LLM не ответил вовремя: {text}"[:1000]
    if "connect" in low:
        return f"Нет соединения с провайдером LLM: {text}"[:1000]
    return f"{name}: {text}"[:1000] if text else name


def knowledge_snippets(svc: Services, path: Path, name: str, limit: int = 6) -> list[str]:
    """Фрагменты пользовательской базы знаний, близкие к началу документа (встроенные критерии ядро знает само)."""
    try:
        if path.suffix.lower() in (".md", ".markdown", ".txt"):
            query = path.read_text(encoding="utf-8", errors="replace")[:3000]
        else:
            query = req_core.parse_document(path, name=name).text[:3000]
    except Exception:  # noqa: BLE001
        query = name
    try:
        points = svc.vectors.search(KNOWLEDGE, query or name, limit=limit * 2)
    except Exception:  # noqa: BLE001
        log.warning("knowledge search failed", exc_info=True)
        return []
    return [p.payload["text"] for p in points if p.payload and p.payload.get("source") != "builtin"][:limit]


def run_with_watchdog(fn: Callable[[], Report], progress: Progress, timeout_s: int) -> Report:
    """Ядро работает в отдельном потоке; здесь — проверка отмены и общего таймаута раз в секунду."""
    pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix=f"core-{progress.run_id[:8]}")
    future = pool.submit(fn)
    deadline = time.monotonic() + timeout_s
    try:
        while True:
            try:
                return future.result(timeout=1.0)
            except FutureTimeout:
                if progress.cancelled():
                    raise RunCancelled("run cancelled") from None
                if time.monotonic() > deadline:
                    raise RunTimedOut() from None
    finally:
        # Зависший поток ядра не убить; флаг отмены прервёт его на следующем on_progress.
        if not future.done():
            progress.svc.redis.set(run_cancel_key(progress.run_id), "1", ex=86400)
        pool.shutdown(wait=False, cancel_futures=True)


def _finish(run_id: uuid.UUID, status: RunStage, *, error: str | None = None, message: str = "") -> bool:
    """Финальный статус, если прогон не отменили/удалили раньше. True — записано."""
    with SessionLocal() as db:
        run = db.get(Run, run_id)
        if run is None or run.status == RunStage.CANCELLED.value:
            return False
        run.status = run.stage = status.value
        run.error = error
        run.message = message
        run.finished_at = datetime.now(timezone.utc)
        if status == RunStage.DONE:
            run.progress = 1.0
        db.commit()
        return True


def _record_usage_metrics(provider: str, model: str, report: Report) -> None:
    u = report.usage
    LLM_REQUESTS.labels(provider, model, "ok").inc(u.llm_calls)
    LLM_TOKENS.labels(provider, model, "input").inc(u.prompt_tokens)
    LLM_TOKENS.labels(provider, model, "output").inc(u.completion_tokens)
    if u.cost_usd:
        LLM_COST.labels(provider, model).inc(u.cost_usd)
    for f in report.findings:
        FINDINGS.labels(f.severity.value).inc()


def execute_run(run_id: str, svc: Services | None = None) -> str:
    svc = svc or get_services()
    settings = read_app_settings()  # таймаут и параметры прогона — из админки
    rid = uuid.UUID(run_id)
    started = time.monotonic()
    progress = Progress(svc, run_id)
    provider = "unknown"
    lg = _RunLog(log, {"run_id": run_id})

    with SessionLocal() as db:
        run = db.get(Run, rid)
        if run is None:
            lg.warning("run not found; skipping")
            return "missing"
        if run.status in TERMINAL:
            lg.info("run already finished; skipping", extra={"status": run.status})
            return run.status
        if run.status != RunStage.QUEUED.value:
            lg.warning("run was interrupted (worker restart?); starting over", extra={"status": run.status})
        doc = db.get(Document, run.document_id)
        provider, model = run.provider, run.model
        run.started_at = datetime.now(timezone.utc)
        run.error = None
        db.commit()
        doc_name, doc_key, doc_id = doc.name, doc.s3_key, str(doc.id)
        options = ValidationOptions.model_validate(run.options or {})
        try:
            cfg = build_provider_config(db, provider, model, require_enabled=False)
        except ProviderNotConfigured as e:
            error = str(e)
            _finish(rid, RunStage.FAILED, error=error)
            progress.emit(RunStage.FAILED, 0.0, error)
            RUNS_FINISHED.labels("failed", provider).inc()
            return "failed"

    RUNS_IN_PROGRESS.inc()
    status = RunStage.FAILED
    try:
        lg.info("run started", extra={"provider": provider, "model": model, "document": doc_name})
        progress.emit(RunStage.PARSING, 0.01, "Загрузка документа", force_db=True)
        with tempfile.TemporaryDirectory(prefix="reqcheck-") as tmp:
            path = Path(tmp) / Path(doc_name).name
            svc.store.download_to(doc_key, path)
            extra = knowledge_snippets(svc, path, doc_name)
            if extra:
                options = options.model_copy(update={"knowledge_snippets": [*options.knowledge_snippets, *extra]})
            report = run_with_watchdog(
                lambda: req_core.validate_document(path, cfg, options=options, on_progress=progress.on_core_progress,
                                                   document_name=doc_name),
                progress, settings.run_timeout_s,
            )
        if progress.cancelled():
            raise RunCancelled("run cancelled")

        progress.emit(RunStage.RENDERING, CORE_END + 0.02, "Выгрузка отчёта (MD, DOCX, PDF)", force_db=True)
        artifacts: dict[str, str] = {}
        for fmt, ctype in EXPORT_FORMATS.items():
            try:
                key = f"reports/{run_id}/report.{fmt}"
                svc.store.put(key, req_core.render_report(report, fmt), ctype)  # type: ignore[arg-type]
                artifacts[fmt] = key
            except Exception:  # noqa: BLE001 — JSON-отчёт важнее выгрузок; формат отрисуется по запросу
                lg.warning("export failed", extra={"format": fmt}, exc_info=True)

        with SessionLocal() as db:
            run = db.get(Run, rid)
            if run is None or run.status == RunStage.CANCELLED.value:
                raise RunCancelled("run cancelled")
            db.merge(ReportRow(run_id=rid, data=report.model_dump(mode="json"), artifacts=artifacts))
            run.usage = report.usage.model_dump(mode="json")
            run.summary = summary_from_report(report)
            db.commit()

        progress.emit(RunStage.RENDERING, 0.97, "Индексация для поиска")
        try:
            index_report(svc.vectors, run_id, doc_id, doc_name, report)
        except Exception:  # noqa: BLE001 — поиск похожих не критичен для отчёта
            lg.warning("indexing failed", exc_info=True)

        message = f"Готово: требований {report.summary.requirements_total}, дефектов {report.summary.findings_total}"
        if _finish(rid, RunStage.DONE, message=message):
            status = RunStage.DONE
            _record_usage_metrics(provider, model, report)
            progress.emit(RunStage.DONE, 1.0, message)
        else:
            status = RunStage.CANCELLED
        lg.info("run finished", extra={"status": status.value, "findings": report.summary.findings_total})
        return status.value
    except RunCancelled:
        status = RunStage.CANCELLED
        lg.info("run cancelled")
        if _finish(rid, RunStage.CANCELLED, message="Прогон отменён"):
            progress.emit(RunStage.CANCELLED, 0.0, "Прогон отменён")
        return status.value
    except Exception as e:  # noqa: BLE001
        status = RunStage.FAILED
        error = describe_error(e, settings.run_timeout_s)
        lg.error("run failed", extra={"error": error}, exc_info=not isinstance(e, (RunTimedOut, NotImplementedError)))
        if _finish(rid, RunStage.FAILED, error=error, message=error):
            progress.emit(RunStage.FAILED, 0.0, error)
        return status.value
    finally:
        RUNS_IN_PROGRESS.dec()
        progress.close_stage()
        RUNS_FINISHED.labels(status.value, provider).inc()
        RUN_DURATION.labels(status.value, provider).observe(time.monotonic() - started)


@celery.task(name=TASK_RUN_VALIDATION, acks_late=True, ignore_result=True)
def run_validation(run_id: str) -> str:
    return execute_run(run_id)
