"""Qdrant: коллекции `knowledge` (база знаний) и `requirements` (требования и дефекты прошлых прогонов)."""

from __future__ import annotations

import logging
import threading
import uuid
from typing import Any

from qdrant_client import QdrantClient
from qdrant_client.http import models as qm

from .embeddings import Embedder

log = logging.getLogger(__name__)

KNOWLEDGE = "knowledge"
REQUIREMENTS = "requirements"
_NS = uuid.UUID("6f1d3c1e-4a51-4c8e-9a51-6b6b1d0c2e11")


def point_id(*parts: str) -> str:
    return str(uuid.uuid5(_NS, "/".join(parts)))


class VectorStore:
    def __init__(self, client: QdrantClient, embedder: Embedder):
        self.client = client
        self.embedder = embedder
        self._ready: set[str] = set()
        # коллекции, созданные (или пересозданные из-за смены размерности) этим процессом — нужна переиндексация
        self.created: set[str] = set()
        self._signature: str | None = None
        self._lock = threading.Lock()

    def reset(self) -> None:
        with self._lock:
            self._ready.clear()

    def ensure_collection(self, name: str) -> None:
        signature = self.embedder.signature()
        if signature != self._signature:  # сменились настройки эмбеддингов — перепроверить коллекции
            with self._lock:
                self._ready.clear()
                self._signature = signature
        if name in self._ready:
            return
        with self._lock:
            dim = int(self.embedder.info()["dim"])
            if not self.client.collection_exists(name):
                self.client.create_collection(name, vectors_config=qm.VectorParams(size=dim, distance=qm.Distance.COSINE))
                self.created.add(name)
                log.info("created qdrant collection", extra={"collection": name, "dim": dim})
            else:
                info = self.client.get_collection(name)
                existing = info.config.params.vectors
                size = getattr(existing, "size", None)
                if size is not None and size != dim:
                    log.warning("embedding dimension changed; recreating collection",
                                extra={"collection": name, "old": size, "new": dim})
                    self.client.delete_collection(name)
                    self.client.create_collection(
                        name, vectors_config=qm.VectorParams(size=dim, distance=qm.Distance.COSINE))
                    self.created.add(name)
            self._ready.add(name)

    def upsert(self, collection: str, items: list[tuple[str, str, dict[str, Any]]]) -> int:
        """items: (point_id, text, payload). Текст кладётся в payload["text"]."""
        if not items:
            return 0
        self.ensure_collection(collection)
        vectors = self.embedder.embed([t for _, t, _ in items], "passage")
        points = [
            qm.PointStruct(id=pid, vector=vec, payload={**payload, "text": text})
            for (pid, text, payload), vec in zip(items, vectors, strict=True)
        ]
        for i in range(0, len(points), 128):
            self.client.upsert(collection, points=points[i : i + 128], wait=True)
        return len(points)

    def search(self, collection: str, query: str, limit: int = 10, filters: dict[str, Any] | None = None) -> list[qm.ScoredPoint]:
        self.ensure_collection(collection)
        vector = self.embedder.embed([query], "query")[0]
        flt = None
        if filters:
            flt = qm.Filter(must=[qm.FieldCondition(key=k, match=qm.MatchValue(value=v)) for k, v in filters.items()])
        return self.client.query_points(collection, query=vector, query_filter=flt, limit=limit, with_payload=True).points

    def delete_where(self, collection: str, key: str, value: str) -> None:
        if not self.client.collection_exists(collection):
            return
        self.client.delete(
            collection,
            points_selector=qm.FilterSelector(filter=qm.Filter(must=[qm.FieldCondition(key=key, match=qm.MatchValue(value=value))])),
            wait=True,
        )

    def ping(self) -> None:
        self.client.get_collections()
