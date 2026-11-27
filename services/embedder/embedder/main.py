"""Сервис эмбеддингов ReqCheck: POST /embed, GET /info, GET /health, GET /metrics."""

from __future__ import annotations

import json
import logging
import os
import sys
import time
from collections.abc import Callable
from contextlib import asynccontextmanager
from typing import Literal

import httpx
from fastapi import FastAPI, HTTPException, Response
from prometheus_client import CONTENT_TYPE_LATEST, Counter, Histogram, generate_latest
from pydantic import BaseModel, Field

from .backends import Backend, ConfigError, build_local, remote_backend

log = logging.getLogger("embedder")
TEXTS = Counter("reqcheck_embedder_texts_total", "Texts embedded", ["kind"])
LATENCY = Histogram("reqcheck_embedder_request_seconds", "Embed request latency",
                    buckets=(0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30))
ERRORS = Counter("reqcheck_embedder_errors_total", "Embed errors")
MAX_TEXTS = 256
MAX_CHARS = 8000


class _JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        data = {"ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S"), "level": record.levelname.lower(),
                "service": "embedder", "logger": record.name, "msg": record.getMessage()}
        for k in ("provider", "model", "dim", "count", "duration_ms"):
            if hasattr(record, k):
                data[k] = getattr(record, k)
        if record.exc_info:
            data["exc"] = self.formatException(record.exc_info)
        return json.dumps(data, ensure_ascii=False)


def _setup_logging() -> None:
    h = logging.StreamHandler(sys.stdout)
    h.setFormatter(_JsonFormatter())
    root = logging.getLogger()
    root.handlers[:] = [h]
    root.setLevel(os.getenv("LOG_LEVEL", "INFO").upper())
    for name in ("uvicorn", "uvicorn.error"):
        logging.getLogger(name).handlers[:] = []
        logging.getLogger(name).propagate = True
    logging.getLogger("uvicorn.access").disabled = True
    for noisy in ("httpx", "httpcore", "urllib3", "sentence_transformers"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


class EmbedIn(BaseModel):
    texts: list[str] = Field(min_length=1, max_length=MAX_TEXTS)
    kind: Literal["query", "passage"] = "passage"
    # Внешний провайдер задаётся в админке; api передаёт его вместе с ключом в каждом запросе.
    provider: Literal["local", "gemini", "openai"] = "local"
    model: str | None = None
    api_key: str | None = Field(default=None, repr=False)
    dim: int | None = Field(default=None, ge=16, le=4096, description="Только gemini: outputDimensionality")


class EmbedOut(BaseModel):
    vectors: list[list[float]]
    model: str
    dim: int


class InfoOut(BaseModel):
    provider: str
    model: str
    dim: int
    normalized: bool = True


def create_app(backend: Backend | None = None, local_factory: Callable[[], Backend] = build_local) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        _setup_logging()
        if app.state.backend is None:
            start = time.perf_counter()
            app.state.backend = local_factory()
            b = app.state.backend
            log.info("embedder ready", extra={"provider": b.provider, "model": b.model, "dim": b.dim,
                                              "duration_ms": round((time.perf_counter() - start) * 1000)})
        yield

    app = FastAPI(title="ReqCheck embedder", version="1.0.0", lifespan=lifespan)
    app.state.backend = backend

    @app.post("/embed", response_model=EmbedOut)
    def embed(body: EmbedIn) -> EmbedOut:
        try:
            b: Backend = app.state.backend if body.provider == "local" else remote_backend(
                body.provider, body.model, body.api_key, body.dim)
        except ConfigError as e:
            raise HTTPException(400, str(e)) from e
        texts = [t[:MAX_CHARS] if t.strip() else " " for t in body.texts]
        start = time.perf_counter()
        try:
            vectors = b.embed(texts, body.kind)
        except httpx.HTTPError as e:
            ERRORS.inc()
            log.warning("embedding provider error: %s", e)
            status = e.response.status_code if isinstance(e, httpx.HTTPStatusError) else None
            raise HTTPException(502, f"Embedding provider {body.provider} error"
                                     f"{f' (HTTP {status})' if status else ''}: {type(e).__name__}") from e
        LATENCY.observe(time.perf_counter() - start)
        TEXTS.labels(body.kind).inc(len(texts))
        return EmbedOut(vectors=vectors, model=b.model, dim=len(vectors[0]) if vectors else b.dim)

    @app.get("/info", response_model=InfoOut)
    def info() -> InfoOut:
        b: Backend = app.state.backend
        return InfoOut(provider=b.provider, model=b.model, dim=b.dim)

    @app.get("/health")
    def health() -> dict:
        return {"status": "ok"}

    @app.get("/metrics", include_in_schema=False)
    def metrics() -> Response:
        return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)

    return app


app = create_app()
