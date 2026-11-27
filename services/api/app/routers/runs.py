from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from collections.abc import AsyncIterator
from datetime import datetime, timezone
from typing import Literal

import redis.asyncio as aioredis
import req_core
from fastapi import APIRouter, Query, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse
from req_contracts import ProgressEvent, Report, RunStage, ValidationOptions
from sqlalchemy import func, select
from sqlalchemy.orm import joinedload
from starlette.concurrency import run_in_threadpool

from ..app_settings import get_app_settings
from ..audit import audit
from ..config import get_settings
from ..db import SessionLocal
from ..deps import DB, CurrentUser, Svc, parse_uuid
from ..errors import ApiError, not_found
from ..metrics import RUNS_CREATED, SSE_CONNECTIONS
from ..models import Document, FindingReview, ReportRow, Run
from ..providers import ProviderNotConfigured, build_provider_config, default_provider
from ..schemas import ErrorOut, FindingReviewIn, FindingReviewOut, FindingWithReview, RunCreate, RunList, RunOut
from ..serialize import TERMINAL, run_out
from ..services import run_cancel_key, run_events_channel
from ..vectors import REQUIREMENTS
from .documents import content_disposition

router = APIRouter(prefix="/runs", tags=["runs"])
log = logging.getLogger(__name__)

EXPORT_TYPES = {
    "md": "text/markdown; charset=utf-8",
    "json": "application/json",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "pdf": "application/pdf",
}
KEEPALIVE_S = 15.0


def get_run(db, run_id: str) -> Run:
    run = db.scalar(select(Run).options(joinedload(Run.document)).where(Run.id == parse_uuid(run_id, "Прогон")))
    if run is None:
        raise not_found("Прогон")
    return run


def publish_event(svc, run_id: str, event: ProgressEvent) -> None:
    try:
        svc.redis.publish(run_events_channel(run_id), event.model_dump_json())
    except Exception:  # noqa: BLE001
        log.warning("redis publish failed", exc_info=True)


@router.post("", response_model=RunOut, status_code=202, responses={400: {"model": ErrorOut}, 404: {"model": ErrorOut}})
def create_run(body: RunCreate, request: Request, user: CurrentUser, db: DB, svc: Svc) -> RunOut:
    doc = db.get(Document, parse_uuid(body.document_id, "Документ"))
    if doc is None:
        raise not_found("Документ")
    provider = body.provider.value if body.provider else default_provider(db)
    try:
        cfg = build_provider_config(db, provider, body.model)
    except ProviderNotConfigured as e:
        raise ApiError(400, "provider_not_configured", str(e)) from e
    # batch_size/concurrency из настроек админки, если клиент не задал их явно
    requested = body.options or ValidationOptions()
    settings = get_app_settings(db)
    defaults = {k: getattr(settings, k) for k in ("batch_size", "concurrency") if k not in requested.model_fields_set}
    options = requested.model_copy(update=defaults).model_dump(mode="json")
    run = Run(id=uuid.uuid4(), document_id=doc.id, status=RunStage.QUEUED.value, stage=RunStage.QUEUED.value,
              progress=0.0, message="В очереди", provider=provider, model=cfg.model, options=options)
    db.add(run)
    audit(db, user.username, "run_created", str(run.id), {"document_id": str(doc.id), "provider": provider,
                                                          "model": cfg.model}, request, commit=False)
    db.commit()
    try:
        run.task_id = svc.enqueue_run(str(run.id))
    except Exception as e:  # noqa: BLE001
        log.exception("enqueue failed")
        run.status = run.stage = RunStage.FAILED.value
        run.error = f"Не удалось поставить задачу в очередь: {e}"
        run.finished_at = datetime.now(timezone.utc)
    db.commit()
    RUNS_CREATED.labels(provider=provider).inc()
    return run_out(run, doc.name)


@router.get("", response_model=RunList)
def list_runs(_: CurrentUser, db: DB, document_id: str | None = None, status: RunStage | None = None,
              limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0)) -> RunList:
    stmt = select(Run)
    if document_id:
        stmt = stmt.where(Run.document_id == parse_uuid(document_id, "Документ"))
    if status:
        stmt = stmt.where(Run.status == status.value)
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    runs = db.scalars(stmt.options(joinedload(Run.document)).order_by(Run.created_at.desc()).limit(limit)
                      .offset(offset)).all()
    return RunList(items=[run_out(r) for r in runs], total=total)


@router.get("/{run_id}", response_model=RunOut, responses={404: {"model": ErrorOut}})
def read_run(run_id: str, _: CurrentUser, db: DB) -> RunOut:
    return run_out(get_run(db, run_id))


def cancel_run_row(db, svc, run: Run, actor: str, request: Request | None = None) -> None:
    if run.status in TERMINAL:
        return
    svc.redis.set(run_cancel_key(str(run.id)), "1", ex=86400)
    if run.task_id:
        try:
            svc.celery.control.revoke(run.task_id)
        except Exception:  # noqa: BLE001
            log.warning("celery revoke failed", exc_info=True)
    run.status = run.stage = RunStage.CANCELLED.value
    run.message = "Прогон отменён пользователем"
    run.finished_at = datetime.now(timezone.utc)
    audit(db, actor, "run_cancelled", str(run.id), request=request, commit=False)
    db.commit()
    publish_event(svc, str(run.id), ProgressEvent(run_id=str(run.id), stage=RunStage.CANCELLED, progress=run.progress,
                                                  message=run.message))


@router.post("/{run_id}/cancel", response_model=RunOut, responses={404: {"model": ErrorOut}})
def cancel_run(run_id: str, request: Request, user: CurrentUser, db: DB, svc: Svc) -> RunOut:
    run = get_run(db, run_id)
    cancel_run_row(db, svc, run, user.username, request)
    return run_out(run)


@router.delete("/{run_id}", status_code=204, responses={404: {"model": ErrorOut}})
def delete_run(run_id: str, request: Request, user: CurrentUser, db: DB, svc: Svc) -> Response:
    run = get_run(db, run_id)
    cancel_run_row(db, svc, run, user.username, request)
    rid = str(run.id)
    db.delete(run)
    audit(db, user.username, "run_deleted", rid, request=request, commit=False)
    db.commit()
    try:
        svc.store.delete_prefix(f"reports/{rid}/")
        svc.vectors.delete_where(REQUIREMENTS, "run_id", rid)
    except Exception:  # noqa: BLE001
        log.warning("run cleanup failed", exc_info=True)
    return Response(status_code=204)


# ---------------- SSE прогресса ----------------

def _state_event(run_id: uuid.UUID) -> ProgressEvent | None:
    with SessionLocal() as db:
        run = db.get(Run, run_id)
        if run is None:
            return None
        message = run.error if run.status == RunStage.FAILED.value and run.error else run.message
        return ProgressEvent(run_id=str(run.id), stage=RunStage(run.status), progress=run.progress, message=message or "")


def sse(event: str, data: str) -> str:
    lines = "".join(f"data: {line}\n" for line in data.splitlines() or [""])
    return f"event: {event}\n{lines}\n"


async def _progress_stream(request: Request, run_uuid: uuid.UUID) -> AsyncIterator[str]:
    channel = run_events_channel(str(run_uuid))
    client = aioredis.from_url(get_settings().redis_url, decode_responses=True)
    pubsub = client.pubsub()
    SSE_CONNECTIONS.labels(stream="run_events").inc()
    try:
        await pubsub.subscribe(channel)  # подписка до чтения состояния — событие между ними не потеряется
        state = await run_in_threadpool(_state_event, run_uuid)
        if state is None:
            return
        yield "retry: 3000\n\n"
        yield sse("progress", state.model_dump_json())
        if state.stage.value in TERMINAL:
            return
        last_beat = time.monotonic()
        while True:
            if await request.is_disconnected():
                return
            msg = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
            if msg and msg.get("type") == "message":
                try:
                    event = ProgressEvent.model_validate_json(msg["data"])
                except ValueError:
                    continue
                yield sse("progress", event.model_dump_json())
                if event.stage.value in TERMINAL:
                    return
            elif time.monotonic() - last_beat > KEEPALIVE_S:
                last_beat = time.monotonic()
                # страховка: воркер мог упасть, не опубликовав финальное событие
                state = await run_in_threadpool(_state_event, run_uuid)
                if state is None:
                    return
                if state.stage.value in TERMINAL:
                    yield sse("progress", state.model_dump_json())
                    return
                yield ": keepalive\n\n"
            else:
                await asyncio.sleep(0)
    finally:
        SSE_CONNECTIONS.labels(stream="run_events").dec()
        try:
            await pubsub.unsubscribe(channel)
            await pubsub.aclose()
            await client.aclose()
        except Exception:  # noqa: BLE001
            pass


SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"}


@router.get("/{run_id}/events", responses={200: {"content": {"text/event-stream": {}},
                                                 "description": "SSE: event: progress, data: ProgressEvent"},
                                           404: {"model": ErrorOut}})
def run_events(run_id: str, request: Request, _: CurrentUser, db: DB) -> StreamingResponse:
    run = get_run(db, run_id)
    return StreamingResponse(_progress_stream(request, run.id), media_type="text/event-stream", headers=SSE_HEADERS)


# ---------------- Отчёт ----------------

def load_report_row(db, run: Run) -> ReportRow:
    row = db.get(ReportRow, run.id)
    if row is None:
        raise ApiError(404, "report_not_ready", "Отчёт ещё не готов")
    return row


@router.get("/{run_id}/report", response_model=Report, responses={404: {"model": ErrorOut}})
def read_report(run_id: str, _: CurrentUser, db: DB) -> JSONResponse:
    row = load_report_row(db, get_run(db, run_id))
    return JSONResponse(row.data)


def export_filename(run: Run, fmt: str) -> str:
    stem = run.document.name.rsplit(".", 1)[0] if "." in run.document.name else run.document.name
    return f"reqcheck-{stem}-{str(run.id)[:8]}.{fmt}"


@router.get("/{run_id}/report.{fmt}", responses={404: {"model": ErrorOut}, 200: {"content": {
    "application/pdf": {}, "text/markdown": {}, "application/json": {},
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {}}}})
def export_report(run_id: str, fmt: Literal["md", "docx", "pdf", "json"], _: CurrentUser, db: DB, svc: Svc) -> Response:
    run = get_run(db, run_id)
    row = load_report_row(db, run)
    headers = {"Content-Disposition": content_disposition(export_filename(run, fmt))}
    if fmt == "json":
        body = json.dumps(row.data, ensure_ascii=False, indent=2).encode()
        return Response(body, media_type=EXPORT_TYPES[fmt], headers=headers)
    key = (row.artifacts or {}).get(fmt)
    data: bytes | None = None
    if key:
        try:
            data = svc.store.get(key)
        except Exception:  # noqa: BLE001
            log.warning("artifact missing in s3, re-rendering", extra={"key": key})
    if data is None:
        try:
            data = req_core.render_report(Report.model_validate(row.data), fmt)
        except NotImplementedError as e:
            raise ApiError(501, "render_unavailable", f"Выгрузка в {fmt} пока недоступна") from e
        key = f"reports/{run.id}/report.{fmt}"
        try:
            svc.store.put(key, data, EXPORT_TYPES[fmt])
            row.artifacts = {**(row.artifacts or {}), fmt: key}
            db.commit()
        except Exception:  # noqa: BLE001
            log.warning("cannot cache artifact", exc_info=True)
    return Response(data, media_type=EXPORT_TYPES[fmt], headers=headers)


# ---------------- Дефекты ----------------

def review_out(finding_id: str, review: FindingReview | None) -> FindingReviewOut:
    if review is None:
        return FindingReviewOut(finding_id=finding_id, status="open")
    return FindingReviewOut(finding_id=finding_id, status=review.status, comment=review.comment,  # type: ignore[arg-type]
                            updated_at=review.updated_at)


@router.get("/{run_id}/findings", response_model=list[FindingWithReview], responses={404: {"model": ErrorOut}})
def list_findings(run_id: str, _: CurrentUser, db: DB) -> list[FindingWithReview]:
    run = get_run(db, run_id)
    report = Report.model_validate(load_report_row(db, run).data)
    reviews = {r.finding_id: r for r in db.scalars(select(FindingReview).where(FindingReview.run_id == run.id))}
    return [FindingWithReview(finding=f, review=review_out(f.id, reviews.get(f.id))) for f in report.findings]


@router.patch("/{run_id}/findings/{finding_id}", response_model=FindingReviewOut, responses={404: {"model": ErrorOut}})
def review_finding(run_id: str, finding_id: str, body: FindingReviewIn, request: Request, user: CurrentUser,
                   db: DB) -> FindingReviewOut:
    run = get_run(db, run_id)
    data = load_report_row(db, run).data
    if not any(f.get("id") == finding_id for f in data.get("findings", [])):
        raise not_found("Дефект")
    review = db.scalar(select(FindingReview).where(FindingReview.run_id == run.id,
                                                   FindingReview.finding_id == finding_id))
    if review is None:
        review = FindingReview(run_id=run.id, finding_id=finding_id)
        db.add(review)
    review.status = body.status
    if body.comment is not None:
        review.comment = body.comment
    review.updated_at = datetime.now(timezone.utc)
    audit(db, user.username, "finding_reviewed", f"{run.id}/{finding_id}", {"status": body.status}, request,
          commit=False)
    db.commit()
    return review_out(finding_id, review)
