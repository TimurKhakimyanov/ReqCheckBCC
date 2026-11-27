"""Бэкенды эмбеддингов: local (sentence-transformers, офлайн), gemini, openai, hash (тесты/разработка)."""

from __future__ import annotations

import hashlib
import logging
import math
import os
import threading
from typing import Literal, Protocol

import httpx

log = logging.getLogger("embedder")
Kind = Literal["query", "passage"]
DEFAULT_LOCAL_MODEL = "intfloat/multilingual-e5-small"


def _normalize(v: list[float]) -> list[float]:
    n = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / n for x in v]


class Backend(Protocol):
    provider: str
    model: str

    @property
    def dim(self) -> int: ...
    def embed(self, texts: list[str], kind: Kind) -> list[list[float]]: ...


class LocalBackend:
    """sentence-transformers на CPU. Модели E5 требуют префиксов «query: » / «passage: »."""

    provider = "local"

    def __init__(self, model: str, batch_size: int = 32):
        from sentence_transformers import SentenceTransformer

        self.model = model
        self.batch_size = batch_size
        self._st = SentenceTransformer(model, device="cpu")
        self._lock = threading.Lock()
        self._e5 = "e5" in model.lower()

    @property
    def dim(self) -> int:
        return int(self._st.get_sentence_embedding_dimension())

    def embed(self, texts: list[str], kind: Kind) -> list[list[float]]:
        if self._e5:
            texts = [f"{kind}: {t}" for t in texts]
        with self._lock:
            vectors = self._st.encode(texts, batch_size=self.batch_size, normalize_embeddings=True,
                                      convert_to_numpy=True, show_progress_bar=False)
        return [v.tolist() for v in vectors]


class GeminiBackend:
    provider = "gemini"
    URL = "https://generativelanguage.googleapis.com/v1beta"

    def __init__(self, model: str, api_key: str, dim: int = 768, client: httpx.Client | None = None):
        if not api_key:
            raise RuntimeError("EMBEDDINGS_PROVIDER=gemini requires GEMINI_API_KEY (or EMBEDDINGS_API_KEY)")
        self.model = model
        self._dim = dim
        self._key = api_key
        self._client = client or httpx.Client(timeout=60)

    @property
    def dim(self) -> int:
        return self._dim

    def embed(self, texts: list[str], kind: Kind) -> list[list[float]]:
        task = "RETRIEVAL_QUERY" if kind == "query" else "RETRIEVAL_DOCUMENT"
        out: list[list[float]] = []
        for i in range(0, len(texts), 100):
            body = {"requests": [{"model": f"models/{self.model}", "content": {"parts": [{"text": t}]},
                                  "taskType": task, "outputDimensionality": self._dim} for t in texts[i : i + 100]]}
            r = self._client.post(f"{self.URL}/models/{self.model}:batchEmbedContents", json=body,
                                  headers={"x-goog-api-key": self._key})
            r.raise_for_status()
            out.extend(_normalize(e["values"]) for e in r.json()["embeddings"])
        return out


class OpenAIBackend:
    provider = "openai"

    def __init__(self, model: str, api_key: str, base_url: str = "https://api.openai.com/v1",
                 client: httpx.Client | None = None):
        if not api_key:
            raise RuntimeError("EMBEDDINGS_PROVIDER=openai requires OPENAI_API_KEY (or EMBEDDINGS_API_KEY)")
        self.model = model
        self._key = api_key
        self._base = base_url.rstrip("/")
        self._client = client or httpx.Client(timeout=60)
        self._dim: int | None = None

    @property
    def dim(self) -> int:
        if self._dim is None:
            self._dim = len(self.embed(["dimension probe"], "query")[0])
        return self._dim

    def embed(self, texts: list[str], kind: Kind) -> list[list[float]]:
        out: list[list[float]] = []
        for i in range(0, len(texts), 256):
            r = self._client.post(f"{self._base}/embeddings", json={"model": self.model, "input": texts[i : i + 256]},
                                  headers={"Authorization": f"Bearer {self._key}"})
            r.raise_for_status()
            data = sorted(r.json()["data"], key=lambda d: d["index"])
            out.extend(_normalize(d["embedding"]) for d in data)
        if out and self._dim is None:
            self._dim = len(out[0])
        return out


class HashBackend:
    """Детерминированные векторы по словам: без модели, для тестов и отладки."""

    provider = "hash"

    def __init__(self, dim: int = 64):
        self.model = f"hash-{dim}"
        self._dim = dim

    @property
    def dim(self) -> int:
        return self._dim

    def embed(self, texts: list[str], kind: Kind) -> list[list[float]]:
        out = []
        for t in texts:
            v = [0.0] * self._dim
            for w in t.lower().split():
                v[int(hashlib.md5(w.encode()).hexdigest(), 16) % self._dim] += 1.0
            out.append(_normalize(v))
        return out


def build_backend(env: dict[str, str] | None = None) -> Backend:
    env = dict(os.environ if env is None else env)
    provider = env.get("EMBEDDINGS_PROVIDER", "local").strip().lower() or "local"
    model = env.get("EMBEDDINGS_MODEL", "").strip()
    key = env.get("EMBEDDINGS_API_KEY", "").strip()
    if provider == "local":
        return LocalBackend(model or DEFAULT_LOCAL_MODEL, int(env.get("EMBEDDINGS_BATCH_SIZE", "32")))
    if model == DEFAULT_LOCAL_MODEL:
        model = ""  # значение по умолчанию из .env относится к локальной модели
    if provider == "gemini":
        return GeminiBackend(model or "gemini-embedding-001", key or env.get("GEMINI_API_KEY", ""),
                             int(env.get("EMBEDDINGS_DIM", "768")))
    if provider == "openai":
        return OpenAIBackend(model or "text-embedding-3-small", key or env.get("OPENAI_API_KEY", ""),
                             env.get("EMBEDDINGS_BASE_URL") or "https://api.openai.com/v1")
    if provider == "hash":
        return HashBackend(int(env.get("EMBEDDINGS_DIM", "64")))
    raise RuntimeError(f"Unknown EMBEDDINGS_PROVIDER={provider!r}: use local, gemini or openai")
