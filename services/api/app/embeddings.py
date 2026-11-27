"""Клиент сервиса embedder (POST /embed, GET /info)."""

from __future__ import annotations

import hashlib
import math
from typing import Literal, Protocol

import httpx

Kind = Literal["query", "passage"]


class Embedder(Protocol):
    def embed(self, texts: list[str], kind: Kind) -> list[list[float]]: ...
    def info(self) -> dict: ...


class EmbedderError(RuntimeError):
    pass


class HttpEmbedder:
    def __init__(self, url: str, timeout: float = 60.0):
        self.url = url.rstrip("/")
        self.timeout = timeout
        self._info: dict | None = None

    def info(self) -> dict:
        if self._info is None:
            try:
                r = httpx.get(f"{self.url}/info", timeout=5.0)
                r.raise_for_status()
            except httpx.HTTPError as e:
                raise EmbedderError(f"embedder unavailable: {e}") from e
            self._info = r.json()
        return self._info

    def embed(self, texts: list[str], kind: Kind) -> list[list[float]]:
        if not texts:
            return []
        out: list[list[float]] = []
        for i in range(0, len(texts), 64):
            try:
                r = httpx.post(f"{self.url}/embed", json={"texts": texts[i : i + 64], "kind": kind},
                               timeout=self.timeout)
                r.raise_for_status()
            except httpx.HTTPError as e:
                raise EmbedderError(f"embedder error: {e}") from e
            out.extend(r.json()["vectors"])
        return out


class HashEmbedder:
    """Детерминированные векторы по словам — для тестов (похожие тексты → близкие векторы)."""

    def __init__(self, dim: int = 64):
        self.dim = dim

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
