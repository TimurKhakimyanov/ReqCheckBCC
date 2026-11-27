"""База знаний: нарезка, индексация в Qdrant, встроенный пересказ критериев 29148/830."""

from __future__ import annotations

import logging
import re
import tempfile
import threading
import time
import uuid
from pathlib import Path

import req_core
from req_contracts import CRITERIA, Report
from sqlalchemy import select

from .db import SessionLocal
from .embeddings import EmbedderError
from .indexing import index_report
from .models import Document, KnowledgeItem, ReportRow, Run
from .services import Services
from .vectors import KNOWLEDGE, REQUIREMENTS, point_id

log = logging.getLogger(__name__)
BUILTIN_TITLE = "Критерии качества требований (ISO/IEC/IEEE 29148, IEEE 830) — пересказ"
CHUNK_CHARS = 900
CHUNK_OVERLAP = 150


def builtin_chunks() -> list[str]:
    chunks = []
    for info in CRITERIA.values():
        level = "отдельного требования" if info.level == "requirement" else "набора требований"
        chunks.append(
            f"Критерий «{info.title_ru}» ({info.title_en}, код {info.code.value}) — свойство {level}. "
            f"Ссылки: {', '.join(info.references)}. {info.description_ru}"
        )
    return chunks


def builtin_text() -> str:
    return "\n\n".join(builtin_chunks())


def chunk_text(text: str, size: int = CHUNK_CHARS, overlap: int = CHUNK_OVERLAP) -> list[str]:
    """Нарезка по абзацам с добивкой до ~size символов; длинные абзацы режутся окном с перекрытием."""
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    chunks: list[str] = []
    buf = ""
    for p in paragraphs:
        if len(p) > size:
            if buf:
                chunks.append(buf)
                buf = ""
            step = size - overlap
            chunks.extend(p[i : i + size] for i in range(0, len(p), step))
            continue
        if buf and len(buf) + len(p) + 2 > size:
            chunks.append(buf)
            buf = p
        else:
            buf = f"{buf}\n\n{p}" if buf else p
    if buf:
        chunks.append(buf)
    return chunks


def extract_text(filename: str, data: bytes) -> str:
    suffix = Path(filename).suffix.lower()
    if suffix in (".md", ".markdown", ".txt"):
        return data.decode("utf-8", errors="replace")
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / f"upload{suffix}"
        path.write_bytes(data)
        return req_core.parse_document(path, name=filename).text


def index_item(svc: Services, item_id: uuid.UUID, chunks: list[str] | None = None) -> None:
    with SessionLocal() as db:
        item = db.get(KnowledgeItem, item_id)
        if item is None:
            return
        try:
            parts = chunks if chunks is not None else chunk_text(item.content)
            if not parts:
                raise ValueError("В документе не найден текст")
            svc.vectors.delete_where(KNOWLEDGE, "item_id", str(item.id))
            svc.vectors.upsert(KNOWLEDGE, [
                (point_id("knowledge", str(item.id), str(i)), text,
                 {"item_id": str(item.id), "title": item.title, "source": item.source, "chunk": i})
                for i, text in enumerate(parts)
            ])
            item.chunks, item.status, item.error = len(parts), "ready", None
        except Exception as e:  # noqa: BLE001
            log.warning("knowledge indexing failed", extra={"item_id": str(item_id), "error": str(e)},
                        exc_info=not isinstance(e, EmbedderError))
            item.status, item.error = "failed", f"{type(e).__name__}: {e}"[:500]
        db.commit()


def ensure_builtin(svc: Services) -> bool:
    """Создаёт и индексирует встроенный элемент. True — готово (или уже было)."""
    with SessionLocal() as db:
        item = db.scalar(select(KnowledgeItem).where(KnowledgeItem.source == "builtin"))
        if item is None:
            item = KnowledgeItem(title=BUILTIN_TITLE, source="builtin", content=builtin_text(), status="indexing")
            db.add(item)
            db.commit()
        if item.status == "ready":
            return True
        item_id = item.id
    index_item(svc, item_id, builtin_chunks())
    with SessionLocal() as db:
        return db.get(KnowledgeItem, item_id).status == "ready"


def sync_vectors(svc: Services) -> bool:
    """Старт api: если коллекции Qdrant созданы заново (пустой Qdrant или смена модели эмбеддингов) —
    переиндексировать базу знаний и отчёты прошлых прогонов; затем убедиться во встроенном элементе."""
    svc.vectors.ensure_collection(KNOWLEDGE)
    svc.vectors.ensure_collection(REQUIREMENTS)
    with SessionLocal() as db:
        if KNOWLEDGE in svc.vectors.created:
            items = db.scalars(select(KnowledgeItem).where(KnowledgeItem.source != "builtin")).all()
            for item in items:
                item.status = "indexing"
            builtin = db.scalar(select(KnowledgeItem).where(KnowledgeItem.source == "builtin"))
            if builtin is not None:
                builtin.status = "indexing"
            db.commit()
            for item in items:
                index_item(svc, item.id)
            log.info("knowledge reindexed", extra={"items": len(items)})
            svc.vectors.created.discard(KNOWLEDGE)
        if REQUIREMENTS in svc.vectors.created:
            rows = db.execute(select(ReportRow.run_id, ReportRow.data, Document.id, Document.name)
                              .join(Run, Run.id == ReportRow.run_id).join(Document, Document.id == Run.document_id)).all()
            for run_id, data, doc_id, doc_name in rows:
                index_report(svc.vectors, str(run_id), str(doc_id), doc_name, Report.model_validate(data))
            log.info("past runs reindexed", extra={"runs": len(rows)})
            svc.vectors.created.discard(REQUIREMENTS)
    return ensure_builtin(svc)


def start_builtin_indexer(svc: Services, attempts: int = 60, delay_s: float = 10.0) -> threading.Thread:
    """Фоновая индексация при старте: embedder может грузить модель дольше, чем стартует api."""

    def _loop() -> None:
        for attempt in range(attempts):
            try:
                if sync_vectors(svc):
                    log.info("builtin knowledge ready")
                    return
            except Exception as e:  # noqa: BLE001
                log.warning("builtin knowledge indexing attempt failed", extra={"attempt": attempt, "error": str(e)},
                            exc_info=not isinstance(e, EmbedderError))
            time.sleep(delay_s)

    t = threading.Thread(target=_loop, name="builtin-knowledge", daemon=True)
    t.start()
    return t
