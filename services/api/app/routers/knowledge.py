from __future__ import annotations

import logging
import uuid

from fastapi import APIRouter, BackgroundTasks, Query, Request, Response
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from ..audit import audit
from ..app_settings import get_app_settings
from ..deps import DB, CurrentUser, Svc, parse_uuid
from ..errors import ApiError, not_found
from ..knowledge import extract_text, index_item
from ..models import KnowledgeItem, utcnow
from ..schemas import (
    ErrorOut,
    KnowledgeDetailOut,
    KnowledgeGraphOut,
    KnowledgeIn,
    KnowledgeItemOut,
    KnowledgeLinkOut,
    KnowledgePatch,
    KnowledgeRef,
    SearchHit,
)
from ..vectors import KNOWLEDGE, REQUIREMENTS
from ..wiki import Note, build_graph, criteria_mentions, normalize_folder, resolve_links
from .documents import FORMATS, safe_name

router = APIRouter(tags=["knowledge"])
log = logging.getLogger(__name__)


def item_out(i: KnowledgeItem) -> KnowledgeItemOut:
    return KnowledgeItemOut(id=str(i.id), title=i.title, source=i.source, chunks=i.chunks, status=i.status,  # type: ignore[arg-type]
                            created_at=i.created_at, error=i.error, folder=i.folder or "", updated_at=i.updated_at,
                            chars=len(i.content or ""))


def _note(i: KnowledgeItem) -> Note:
    return Note(id=str(i.id), title=i.title, folder=i.folder or "", source=i.source, content=i.content or "")


def _get_item(db: Session, item_id: str) -> KnowledgeItem:
    item = db.get(KnowledgeItem, parse_uuid(item_id, "Элемент базы знаний"))
    if item is None:
        raise not_found("Элемент базы знаний")
    return item


@router.get("/search", response_model=list[SearchHit], responses={503: {"model": ErrorOut}})
def search(_: CurrentUser, svc: Svc, q: str = Query(min_length=1, max_length=2000),
           kind: str | None = Query(None, pattern="^(requirement|finding)$"),
           limit: int = Query(10, ge=1, le=50)) -> list[SearchHit]:
    try:
        points = svc.vectors.search(REQUIREMENTS, q, limit=limit, filters={"kind": kind} if kind else None)
    except Exception as e:  # noqa: BLE001
        log.warning("search failed", exc_info=True)
        raise ApiError(503, "search_unavailable", "Поиск временно недоступен (embedder или Qdrant)") from e
    hits = []
    for p in points:
        pl = p.payload or {}
        hits.append(SearchHit(score=round(float(p.score), 4), kind=pl.get("kind", "requirement"), text=pl.get("text", ""),
                              run_id=pl.get("run_id", ""), document_name=pl.get("document_name", ""),
                              requirement_id=pl.get("requirement_id"), finding_id=pl.get("finding_id")))
    return hits


@router.get("/knowledge", response_model=list[KnowledgeItemOut])
def list_knowledge(_: CurrentUser, db: DB) -> list[KnowledgeItemOut]:
    items = db.scalars(select(KnowledgeItem).order_by(KnowledgeItem.created_at)).all()
    return [item_out(i) for i in items]


@router.post("/knowledge", response_model=KnowledgeItemOut, status_code=201,
             responses={400: {"model": ErrorOut}, 413: {"model": ErrorOut}, 415: {"model": ErrorOut}},
             openapi_extra={"requestBody": {"required": True, "content": {
                 "multipart/form-data": {"schema": {"type": "object", "required": ["file"], "properties": {
                     "file": {"type": "string", "format": "binary"}, "title": {"type": "string"}}}},
                 "application/json": {"schema": KnowledgeIn.model_json_schema()},
             }}})
async def add_knowledge(request: Request, background: BackgroundTasks, user: CurrentUser, db: DB,
                        svc: Svc) -> KnowledgeItemOut:
    ctype = request.headers.get("content-type", "")
    if ctype.startswith("multipart/form-data"):
        form = await request.form()
        upload = form.get("file")
        if upload is None or isinstance(upload, str):
            raise ApiError(400, "file_required", "Не передан файл")
        name = safe_name(upload.filename or "knowledge.txt")
        if FORMATS.get("." + name.rsplit(".", 1)[-1].lower()) is None:
            raise ApiError(415, "unsupported_format", "Поддерживаются файлы PDF, DOCX, MD и TXT")
        max_mb = get_app_settings(db).max_upload_mb
        limit = max_mb * 1024 * 1024
        data = await upload.read(limit + 1)
        if len(data) > limit:
            raise ApiError(413, "file_too_large", f"Файл больше {max_mb} МБ")
        try:
            text = await run_in_threadpool(extract_text, name, data)
        except NotImplementedError as e:
            raise ApiError(415, "unsupported_format", "Разбор этого формата пока недоступен; загрузите MD или TXT") from e
        except Exception as e:  # noqa: BLE001
            raise ApiError(400, "parse_failed", f"Не удалось извлечь текст: {e}") from e
        title = str(form.get("title") or name.rsplit(".", 1)[0])
        folder = normalize_folder(str(form.get("folder") or ""))
        source = "upload"
    else:
        try:
            body = KnowledgeIn.model_validate(await request.json())
        except (ValidationError, ValueError) as e:
            raise ApiError(422, "validation_error", "Ожидается {title, text} или multipart с файлом") from e
        title, text, source, folder = body.title, body.text, "manual", normalize_folder(body.folder)
    if not text.strip():
        raise ApiError(400, "empty_text", "В документе нет текста")
    item = KnowledgeItem(id=uuid.uuid4(), title=title[:500], source=source, content=text, status="indexing",
                         folder=folder)
    db.add(item)
    audit(db, user.username, "knowledge_added", str(item.id), {"title": item.title, "source": source}, request,
          commit=False)
    db.commit()
    background.add_task(index_item, svc, item.id)
    return item_out(item)


@router.get("/knowledge/graph", response_model=KnowledgeGraphOut)
def knowledge_graph(_: CurrentUser, db: DB) -> KnowledgeGraphOut:
    """Граф вики: заметки, папки, упомянутые критерии; рёбра — ссылки [[…]], упоминания и вложенность."""
    items = db.scalars(select(KnowledgeItem).order_by(KnowledgeItem.created_at)).all()
    return KnowledgeGraphOut.model_validate(build_graph(_note(i) for i in items))


@router.get("/knowledge/{item_id}", response_model=KnowledgeDetailOut, responses={404: {"model": ErrorOut}})
def get_knowledge(item_id: str, _: CurrentUser, db: DB) -> KnowledgeDetailOut:
    item = _get_item(db, item_id)
    items = db.scalars(select(KnowledgeItem)).all()
    links = resolve_links(_note(i) for i in items)
    me = str(item.id)
    titles = {str(i.id): i.title for i in items}
    backlinks = [KnowledgeRef(id=nid, title=titles[nid]) for nid, ls in links.items()
                 if nid != me and any(target == me for _, target in ls)]
    return KnowledgeDetailOut(
        **item_out(item).model_dump(), content=item.content or "",
        links=[KnowledgeLinkOut(title=t, id=target) for t, target in links.get(me, [])],
        backlinks=sorted(backlinks, key=lambda r: r.title.lower()),
        criteria=[c.value for c in criteria_mentions(item.content or "")],
    )


@router.patch("/knowledge/{item_id}", response_model=KnowledgeItemOut,
              responses={404: {"model": ErrorOut}, 409: {"model": ErrorOut}})
def update_knowledge(item_id: str, body: KnowledgePatch, request: Request, background: BackgroundTasks,
                     user: CurrentUser, db: DB, svc: Svc) -> KnowledgeItemOut:
    """Правка заметки: название, папка, текст. Новый текст или название — переиндексация в фоне.
    У встроенного материала можно менять только папку."""
    item = _get_item(db, item_id)
    if item.source == "builtin" and (body.title is not None or body.text is not None):
        raise ApiError(409, "builtin_protected", "Встроенный материал можно только перенести в другую папку")
    changed: dict[str, str] = {}
    reindex = False
    if body.title is not None and body.title.strip() and body.title.strip() != item.title:
        item.title = body.title.strip()[:500]
        changed["title"] = item.title
        reindex = True
    if body.folder is not None and normalize_folder(body.folder) != (item.folder or ""):
        item.folder = normalize_folder(body.folder)
        changed["folder"] = item.folder
    if body.text is not None and body.text != item.content:
        if not body.text.strip():
            raise ApiError(400, "empty_text", "В заметке нет текста")
        item.content = body.text
        changed["text"] = f"{len(body.text)} симв."
        reindex = True
    if changed:
        item.updated_at = utcnow()
        if reindex:
            item.status = "indexing"
        audit(db, user.username, "knowledge_updated", str(item.id), changed, request, commit=False)
        db.commit()
        if reindex:
            background.add_task(index_item, svc, item.id)
    return item_out(item)


@router.delete("/knowledge/{item_id}", status_code=204, responses={404: {"model": ErrorOut}})
def delete_knowledge(item_id: str, request: Request, user: CurrentUser, db: DB, svc: Svc) -> Response:
    item = _get_item(db, item_id)
    if item.source == "builtin":
        raise ApiError(409, "builtin_protected", "Встроенный материал базы знаний удалить нельзя")
    db.delete(item)
    audit(db, user.username, "knowledge_deleted", str(item.id), {"title": item.title}, request, commit=False)
    db.commit()
    try:
        svc.vectors.delete_where(KNOWLEDGE, "item_id", str(item.id))
    except Exception:  # noqa: BLE001
        log.warning("qdrant cleanup failed", exc_info=True)
    return Response(status_code=204)
