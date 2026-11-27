"""Celery-приложение воркера: пул потоков (прогон — это ожидание LLM), метрики Prometheus, JSON-логи."""

from __future__ import annotations

import logging
import os

from app.config import get_settings
from app.logging_setup import setup_logging
from app.services import make_celery
from celery import signals

celery = make_celery("reqcheck-worker")
celery.conf.update(
    worker_pool="threads",
    worker_concurrency=int(os.getenv("WORKER_CONCURRENCY", "2")),
    worker_hijack_root_logger=False,
    worker_send_task_events=False,
    include=["worker.tasks"],
)
log = logging.getLogger("worker")


@signals.setup_logging.connect
def _setup_logging(**_: object) -> None:
    setup_logging("worker", get_settings().log_level)


@signals.worker_ready.connect
def _worker_ready(**_: object) -> None:
    port = int(os.getenv("WORKER_METRICS_PORT", "9101"))
    from .metrics import start_metrics_server

    start_metrics_server(port)
    log.info("worker ready", extra={"metrics_port": port, "concurrency": celery.conf.worker_concurrency})
