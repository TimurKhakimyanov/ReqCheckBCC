"""Внешние зависимости (S3, Qdrant, embedder, Redis, Celery). В тестах подменяются через set_services()."""

from __future__ import annotations

from dataclasses import dataclass
from functools import cached_property

import redis
from celery import Celery
from qdrant_client import QdrantClient

from .config import get_settings
from .app_settings import MAX_RUN_TIMEOUT_S, embedding_config
from .embeddings import Embedder, HttpEmbedder
from .storage import ObjectStore, S3ObjectStore
from .vectors import VectorStore

TASK_RUN_VALIDATION = "reqcheck.run_validation"
# Имя по умолчанию: redis-exporter считает длину очереди по ключу `celery` в db0 (docs/monitoring.md)
CELERY_QUEUE = "celery"


def make_celery(name: str = "reqcheck") -> Celery:
    s = get_settings()
    app = Celery(name, broker=s.redis_url, backend=s.redis_url)
    app.conf.update(
        task_default_queue=CELERY_QUEUE,
        task_serializer="json",
        accept_content=["json"],
        result_serializer="json",
        task_ignore_result=True,
        task_acks_late=True,
        task_reject_on_worker_lost=True,
        worker_prefetch_multiplier=1,
        broker_connection_retry_on_startup=True,
        # задача с acks_late не должна переотправляться, пока идёт долгий прогон
        broker_transport_options={"visibility_timeout": MAX_RUN_TIMEOUT_S + 900},
        result_backend_transport_options={"visibility_timeout": MAX_RUN_TIMEOUT_S + 900},
        timezone="UTC",
    )
    return app


@dataclass
class Services:
    store: ObjectStore
    embedder: Embedder
    qdrant: QdrantClient
    redis: redis.Redis

    @cached_property
    def vectors(self) -> VectorStore:
        return VectorStore(self.qdrant, self.embedder)

    @cached_property
    def celery(self) -> Celery:
        return make_celery("reqcheck-api")

    def enqueue_run(self, run_id: str) -> str:
        result = self.celery.send_task(TASK_RUN_VALIDATION, args=[run_id], queue=CELERY_QUEUE)
        return result.id


_services: Services | None = None


def build_services() -> Services:
    s = get_settings()
    return Services(
        store=S3ObjectStore(s.s3_endpoint_url, s.s3_access_key, s.s3_secret_key, s.s3_bucket, s.s3_region),
        embedder=HttpEmbedder(s.embedder_url, config=embedding_config.get),
        qdrant=QdrantClient(url=s.qdrant_url, api_key=s.qdrant_api_key or None, timeout=30, https=False),
        redis=redis.Redis.from_url(s.redis_url, decode_responses=True),
    )


def get_services() -> Services:
    global _services
    if _services is None:
        _services = build_services()
    return _services


def set_services(services: Services | None) -> None:
    global _services
    _services = services


def run_events_channel(run_id: str) -> str:
    return f"run:{run_id}:events"


def run_cancel_key(run_id: str) -> str:
    return f"run:{run_id}:cancel"


def run_questions_key(run_id: str) -> str:
    """Вопросы автору, на которых прогон остановился и ждёт ответов (веб-аналог --ask bbc-agent)."""
    return f"run:{run_id}:questions"


def run_answers_key(run_id: str) -> str:
    """Ответы автора {Q-01: ответ}, которые API кладёт для ждущего прогона; пустой объект — пропустить вопросы."""
    return f"run:{run_id}:answers"
