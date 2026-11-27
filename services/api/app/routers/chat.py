from __future__ import annotations

import json
import logging
import uuid
from collections.abc import AsyncIterator

import req_core
from fastapi import APIRouter, Request, Response
from fastapi.responses import StreamingResponse
from req_contracts import ProviderConfig, Report
from sqlalchemy import delete, select
from starlette.concurrency import iterate_in_threadpool, run_in_threadpool

from ..audit import audit
from ..db import SessionLocal
from ..deps import DB, CurrentUser, Svc
from ..errors import ApiError
from ..metrics import CHAT_MESSAGES, SSE_CONNECTIONS
from ..models import ChatMessageRow
from ..providers import ProviderNotConfigured, build_provider_config
from ..schemas import ChatIn, ChatMessageOut, ErrorOut
from ..serialize import chat_out
from ..services import Services
from ..vectors import KNOWLEDGE
from .runs import SSE_HEADERS, get_run, load_report_row, sse

router = APIRouter(prefix="/runs/{run_id}/chat", tags=["chat"])
log = logging.getLogger(__name__)
HISTORY_LIMIT = 20


@router.get("", response_model=list[ChatMessageOut], responses={404: {"model": ErrorOut}})
def chat_history(run_id: str, _: CurrentUser, db: DB) -> list[ChatMessageOut]:
    run = get_run(db, run_id)
    rows = db.scalars(select(ChatMessageRow).where(ChatMessageRow.run_id == run.id)
                      .order_by(ChatMessageRow.created_at)).all()
    return [chat_out(m) for m in rows]


@router.delete("", status_code=204, responses={404: {"model": ErrorOut}})
def clear_chat(run_id: str, request: Request, user: CurrentUser, db: DB) -> Response:
    run = get_run(db, run_id)
    db.execute(delete(ChatMessageRow).where(ChatMessageRow.run_id == run.id))
    audit(db, user.username, "chat_cleared", str(run.id), request=request, commit=False)
    db.commit()
    return Response(status_code=204)


def knowledge_snippets(svc: Services, question: str, limit: int = 4) -> list[str]:
    try:
        return [p.payload["text"] for p in svc.vectors.search(KNOWLEDGE, question, limit=limit) if p.payload]
    except Exception:  # noqa: BLE001 — чат работает и без базы знаний
        log.warning("knowledge search failed", exc_info=True)
        return []


def _save_message(run_id: uuid.UUID, role: str, content: str, cfg: ProviderConfig | None) -> ChatMessageRow:
    with SessionLocal() as db:
        row = ChatMessageRow(run_id=run_id, role=role, content=content,
                             provider=cfg.provider.value if cfg else None, model=cfg.model if cfg else None)
        db.add(row)
        db.commit()
        return row


async def _chat_stream(request: Request, svc: Services, run_id: uuid.UUID, report: Report,
                       history: list[req_core.ChatMessage], question: str, cfg: ProviderConfig) -> AsyncIterator[str]:
    SSE_CONNECTIONS.labels(kind="chat").inc()
    parts: list[str] = []
    try:
        snippets = await run_in_threadpool(knowledge_snippets, svc, question)
        tokens = req_core.answer_question(report, history, question, cfg, knowledge_snippets=snippets or None)
        async for token in iterate_in_threadpool(tokens):
            if not token:
                continue
            parts.append(token)
            yield sse("token", json.dumps({"text": token}, ensure_ascii=False))
            if await request.is_disconnected():
                break
        answer = "".join(parts).strip() or "(пустой ответ модели)"
        row = await run_in_threadpool(_save_message, run_id, "assistant", answer, cfg)
        CHAT_MESSAGES.labels(provider=cfg.provider.value, result="ok").inc()
        yield sse("done", chat_out(row).model_dump_json())
    except Exception as e:  # noqa: BLE001
        log.exception("chat failed")
        CHAT_MESSAGES.labels(provider=cfg.provider.value, result="error").inc()
        detail = "Чат пока недоступен: ядро агента не реализовано" if isinstance(e, NotImplementedError) \
            else f"Ошибка модели: {type(e).__name__}: {e}"[:500]
        if parts:  # сохраняем то, что успели получить
            await run_in_threadpool(_save_message, run_id, "assistant", "".join(parts), cfg)
        yield sse("error", json.dumps({"detail": detail, "code": "chat_failed"}, ensure_ascii=False))
    finally:
        SSE_CONNECTIONS.labels(kind="chat").dec()


@router.post("", responses={200: {"content": {"text/event-stream": {}},
                                  "description": "SSE: event: token {text}, затем event: done ChatMessage "
                                                 "(или event: error {detail, code})"},
                            400: {"model": ErrorOut}, 404: {"model": ErrorOut}})
def chat(run_id: str, body: ChatIn, request: Request, user: CurrentUser, db: DB, svc: Svc) -> StreamingResponse:
    run = get_run(db, run_id)
    report = Report.model_validate(load_report_row(db, run).data)
    provider = body.provider.value if body.provider else run.provider
    model = body.model or (run.model if provider == run.provider else None)
    try:
        cfg = build_provider_config(db, provider, model)
    except ProviderNotConfigured as e:
        raise ApiError(400, "provider_not_configured", str(e)) from e
    rows = db.scalars(select(ChatMessageRow).where(ChatMessageRow.run_id == run.id)
                      .order_by(ChatMessageRow.created_at.desc()).limit(HISTORY_LIMIT)).all()
    history = [req_core.ChatMessage(role=m.role, content=m.content, created_at=m.created_at)  # type: ignore[arg-type]
               for m in reversed(rows)]
    _save_message(run.id, "user", body.message, None)
    return StreamingResponse(_chat_stream(request, svc, run.id, report, history, body.message, cfg),
                             media_type="text/event-stream", headers=SSE_HEADERS)
