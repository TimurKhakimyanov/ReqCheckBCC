from __future__ import annotations

import hashlib
import logging
import uuid
from pathlib import PurePath
from urllib.parse import quote

from fastapi import APIRouter, File, Query, Request, Response, UploadFile
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select
from starlette.concurrency import run_in_threadpool

from ..audit import audit
from ..config import get_settings
from ..deps import DB, CurrentUser, Svc, parse_uuid
from ..errors import ApiError, not_found
from ..metrics import DOCUMENTS_UPLOADED
from ..models import Document, Run
from ..schemas import DocumentList, DocumentOut, ErrorOut
from ..serialize import document_out
from ..vectors import REQUIREMENTS

router = APIRouter(prefix="/documents", tags=["documents"])
log = logging.getLogger(__name__)

FORMATS = {".pdf": "pdf", ".docx": "docx", ".md": "md", ".markdown": "md", ".txt": "txt"}
CONTENT_TYPES = {"pdf": "application/pdf", "md": "text/markdown; charset=utf-8", "txt": "text/plain; charset=utf-8",
                 "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"}


def content_disposition(filename: str) -> str:
    ascii_name = filename.encode("ascii", "ignore").decode() or "file"
    ascii_name = ascii_name.replace('"', "")
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename)}"


def safe_name(name: str) -> str:
    base = PurePath(name.replace("\\", "/")).name.strip() or "document"
    return "".join(ch for ch in base if ch.isprintable())[:200]


def _document_with_stats(db, doc: Document) -> DocumentOut:
    count = db.scalar(select(func.count()).select_from(Run).where(Run.document_id == doc.id)) or 0
    last = db.scalar(select(Run).where(Run.document_id == doc.id).order_by(Run.created_at.desc()).limit(1))
    return document_out(doc, count, last)


@router.post("", response_model=DocumentOut, status_code=201,
             responses={413: {"model": ErrorOut}, 415: {"model": ErrorOut}})
async def upload_document(request: Request, user: CurrentUser, db: DB, svc: Svc,
                          file: UploadFile = File(...)) -> DocumentOut:
    name = safe_name(file.filename or "document")
    fmt = FORMATS.get(PurePath(name).suffix.lower())
    if fmt is None:
        raise ApiError(415, "unsupported_format", "Поддерживаются файлы PDF, DOCX, MD и TXT")
    limit = get_settings().max_upload_mb * 1024 * 1024
    data = await file.read(limit + 1)
    if len(data) > limit:
        raise ApiError(413, "file_too_large", f"Файл больше {get_settings().max_upload_mb} МБ")
    if not data:
        raise ApiError(400, "empty_file", "Файл пустой")
    doc = Document(id=uuid.uuid4(), name=name, format=fmt, size_bytes=len(data), sha256=hashlib.sha256(data).hexdigest(),
                   s3_key="")
    doc.s3_key = f"documents/{doc.id}/{name}"
    try:
        await run_in_threadpool(svc.store.put, doc.s3_key, data, CONTENT_TYPES[fmt])
    except Exception as e:
        log.exception("s3 upload failed")
        raise ApiError(503, "storage_unavailable", "Хранилище файлов недоступно") from e
    db.add(doc)
    audit(db, user.username, "document_uploaded", str(doc.id), {"name": name, "size": len(data)}, request, commit=False)
    db.commit()
    DOCUMENTS_UPLOADED.labels(format=fmt).inc()
    return document_out(doc, 0, None)


@router.get("", response_model=DocumentList)
def list_documents(_: CurrentUser, db: DB, limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0),
                   q: str | None = None) -> DocumentList:
    stmt = select(Document)
    if q:
        stmt = stmt.where(Document.name.ilike(f"%{q}%"))
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    docs = db.scalars(stmt.order_by(Document.created_at.desc()).limit(limit).offset(offset)).all()
    return DocumentList(items=[_document_with_stats(db, d) for d in docs], total=total)


def _get_doc(db, document_id: str) -> Document:
    doc = db.get(Document, parse_uuid(document_id, "Документ"))
    if doc is None:
        raise not_found("Документ")
    return doc


@router.get("/{document_id}", response_model=DocumentOut, responses={404: {"model": ErrorOut}})
def get_document(document_id: str, _: CurrentUser, db: DB) -> DocumentOut:
    return _document_with_stats(db, _get_doc(db, document_id))


@router.get("/{document_id}/file", responses={404: {"model": ErrorOut}, 200: {"content": {"application/octet-stream": {}}}})
def download_document(document_id: str, _: CurrentUser, db: DB, svc: Svc) -> StreamingResponse:
    doc = _get_doc(db, document_id)
    if not svc.store.exists(doc.s3_key):
        raise ApiError(404, "file_missing", "Файл документа не найден в хранилище")
    return StreamingResponse(svc.store.iter_chunks(doc.s3_key), media_type=CONTENT_TYPES.get(doc.format),
                             headers={"Content-Disposition": content_disposition(doc.name)})


@router.delete("/{document_id}", status_code=204, responses={404: {"model": ErrorOut}})
def delete_document(document_id: str, request: Request, user: CurrentUser, db: DB, svc: Svc) -> Response:
    doc = _get_doc(db, document_id)
    run_ids = [str(r) for r in db.scalars(select(Run.id).where(Run.document_id == doc.id)).all()]
    for rid in run_ids:
        svc.redis.set(f"run:{rid}:cancel", "1", ex=3600)
    db.delete(doc)
    audit(db, user.username, "document_deleted", str(doc.id), {"name": doc.name, "runs": len(run_ids)}, request,
          commit=False)
    db.commit()
    try:
        svc.store.delete_prefix(f"documents/{doc.id}/")
        for rid in run_ids:
            svc.store.delete_prefix(f"reports/{rid}/")
    except Exception:  # noqa: BLE001 — файл в хранилище подчистим позже, запись уже удалена
        log.warning("s3 cleanup failed", exc_info=True)
    try:
        svc.vectors.delete_where(REQUIREMENTS, "document_id", str(doc.id))
    except Exception:  # noqa: BLE001
        log.warning("qdrant cleanup failed", exc_info=True)
    return Response(status_code=204)
