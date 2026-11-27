"""Клиент сервиса embedder (POST /embed, GET /info).

Провайдер эмбеддингов, модель и ключ берутся из настроек приложения (БД) и передаются в каждом запросе:
сам embedder ключей не знает. По умолчанию — локальная модель внутри embedder.
"""

from __future__ import annotations

import hashlib
import math
import threading
from collections.abc import Callable
from typing import Literal, Protocol

import httpx

from .app_settings import EmbeddingConfig

Kind = Literal["query", "passage"]
LOCAL = EmbeddingConfig(provider="local", model=None, api_key=None, dim=None)


class Embedder(Protocol):
    def embed(self, texts: list[str], kind: Kind) -> list[list[float]]: ...
    def info(self) -> dict: ...
    def signature(self) -> str: ...


class EmbedderError(RuntimeError):
    pass


class HttpEmbedder:
    def __init__(self, url: str, config: Callable[[], EmbeddingConfig] = lambda: LOCAL, timeout: float = 60.0):
        self.url = url.rstrip("/")
        self.timeout = timeout
        self.config = config
        self._info: dict[str, dict] = {}
        self._lock = threading.Lock()

    def signature(self) -> str:
        return self.config().signature

    def info(self) -> dict:
        cfg = self.config()
        with self._lock:
            cached = self._info.get(cfg.signature)
        if cached:
            return cached
        if cfg.provider == "local":
            try:
                r = httpx.get(f"{self.url}/info", timeout=5.0)
                r.raise_for_status()
            except httpx.HTTPError as e:
                raise EmbedderError(f"embedder unavailable: {e}") from e
            info = r.json()
        else:  # размерность внешней модели — по пробному вектору
            vec = self._post(["dimension probe"], "query", cfg)[0]
            info = {"provider": cfg.provider, "model": cfg.model, "dim": len(vec)}
        with self._lock:
            self._info[cfg.signature] = info
        return info

    def _post(self, texts: list[str], kind: Kind, cfg: EmbeddingConfig) -> list[list[float]]:
        try:
            r = httpx.post(f"{self.url}/embed", json={"texts": texts, "kind": kind, **cfg.request_fields()},
                           timeout=self.timeout)
        except httpx.HTTPError as e:
            raise EmbedderError(f"embedder unavailable: {e}") from e
        if r.status_code >= 400:
            try:
                detail = r.json().get("detail")
            except ValueError:
                detail = r.text[:300]
            raise EmbedderError(f"embedder error {r.status_code}: {detail}")
        return r.json()["vectors"]

    def embed(self, texts: list[str], kind: Kind) -> list[list[float]]:
        if not texts:
            return []
        cfg = self.config()
        out: list[list[float]] = []
        for i in range(0, len(texts), 64):
            out.extend(self._post(texts[i : i + 64], kind, cfg))
        return out


class HashEmbedder:
    """Детерминированные векторы по словам — для тестов (похожие тексты → близкие векторы)."""

    def __init__(self, dim: int = 64):
        self.dim = dim

    def signature(self) -> str:
        return f"hash:{self.dim}"

    def info(self) -> dict:
        return {"provider": "hash", "model": "hash", "dim": self.dim}

    def embed(self, texts: list[str], kind: Kind) -> list[list[float]]:
        vectors = []
        for text in texts:
            v = [0.0] * self.dim
            for word in text.lower().split():
                h = int(hashlib.md5(word.encode()).hexdigest(), 16)
                v[h % self.dim] += 1.0
            norm = math.sqrt(sum(x * x for x in v)) or 1.0
            vectors.append([x / norm for x in v])
        return vectors
