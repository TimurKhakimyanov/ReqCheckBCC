"""Метрики воркера (worker:9101/metrics). Имена и метки — по docs/monitoring.md.

При заданном PROMETHEUS_MULTIPROC_DIR prometheus_client пишет значения в файлы каталога, а HTTP-сервер
главного процесса собирает их MultiProcessCollector'ом (нужно для пула prefork; с пулом threads тоже работает).
"""

import os

from prometheus_client import CollectorRegistry, Counter, Gauge, Histogram, start_http_server
from prometheus_client import multiprocess

RUN_BUCKETS = (10, 30, 60, 120, 300, 600, 1200, 1800, 3600)

RUNS_FINISHED = Counter("reqcheck_runs_total", "Finished runs", ["status", "provider"])
RUN_DURATION = Histogram("reqcheck_run_duration_seconds", "Run duration", ["status", "provider"], buckets=RUN_BUCKETS)
STAGE_DURATION = Histogram("reqcheck_run_stage_duration_seconds", "Pipeline stage duration", ["stage"],
                           buckets=(1, 5, *RUN_BUCKETS))
RUNS_IN_PROGRESS = Gauge("reqcheck_runs_in_progress", "Runs in progress", multiprocess_mode="livesum")
FINDINGS = Counter("reqcheck_findings_total", "Findings reported", ["severity"])
# Ядро отдаёт только итоги usage: число вызовов (outcome=ok) и токены. Латентность и ошибки каждого вызова видит только ядро — в бэклоге.
LLM_REQUESTS = Counter("reqcheck_llm_requests_total", "LLM requests", ["provider", "model", "outcome"])
LLM_TOKENS = Counter("reqcheck_llm_tokens_total", "LLM tokens", ["provider", "model", "type"])
LLM_COST = Counter("reqcheck_llm_cost_usd_total", "Estimated LLM cost, USD", ["provider", "model"])


def start_metrics_server(port: int) -> None:
    if os.getenv("PROMETHEUS_MULTIPROC_DIR"):
        registry = CollectorRegistry()
        multiprocess.MultiProcessCollector(registry)
        start_http_server(port, registry=registry)
    else:
        start_http_server(port)
