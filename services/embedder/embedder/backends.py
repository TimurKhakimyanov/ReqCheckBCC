"""Бэкенды эмбеддингов: local (sentence-transformers, офлайн), gemini, openai, hash (тесты/разработка)."""

from __future__ import annotations

import hashlib
import logging
import math
import threading
from pathlib import Path
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


MODEL_FILE = Path("/models/MODEL")  # имя локальной модели, вшитой при сборке образа (аргумент EMBEDDINGS_MODEL)
REMOTE_DEFAULT_MODELS = {"gemini": "gemini-embedding-001", "openai": "text-embedding-3-small"}
_remote_cache: dict[tuple, Backend] = {}
_remote_lock = threading.Lock()


def local_model_name() -> str:
    try:
        return MODEL_FILE.read_text(encoding="utf-8").strip() or DEFAULT_LOCAL_MODEL
    except OSError:
        return DEFAULT_LOCAL_MODEL


def build_local() -> Backend:
    return LocalBackend(local_model_name())


class ConfigError(ValueError):
    pass


def remote_backend(provider: str, model: str | None, api_key: str | None, dim: int | None = None) -> Backend:
    """Внешний провайдер с ключом из запроса (ключи хранит api в БД; embedder их не сохраняет)."""
    if provider not in REMOTE_DEFAULT_MODELS:
        raise ConfigError(f"Unknown embeddings provider {provider!r}: use local, gemini or openai")
    if not api_key:
        raise ConfigError(f"Embeddings provider {provider} requires api_key (set it in the admin settings)")
    model = model or REMOTE_DEFAULT_MODELS[provider]
    key = (provider, model, hashlib.sha256(api_key.encode()).hexdigest(), dim)
    with _remote_lock:
        backend = _remote_cache.get(key)
        if backend is None:
            backend = (GeminiBackend(model, api_key, dim or 768) if provider == "gemini"
                       else OpenAIBackend(model, api_key))
            if len(_remote_cache) > 16:
                _remote_cache.clear()
            _remote_cache[key] = backend
    return backend
