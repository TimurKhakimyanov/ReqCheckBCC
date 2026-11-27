"""Метрики Prometheus сервиса api (GET /metrics)."""

from __future__ import annotations

import logging
import time

from prometheus_client import Counter, Gauge, Histogram
from starlette.types import ASGIApp, Receive, Scope, Send

HTTP_REQUESTS = Counter("reqcheck_http_requests_total", "HTTP requests", ["method", "route", "status"])
HTTP_LATENCY = Histogram("reqcheck_http_request_duration_seconds", "HTTP request latency", ["method", "route"],
                         buckets=(0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30))
LOGINS = Counter("reqcheck_logins_total", "Login attempts", ["result"])
RUNS_CREATED = Counter("reqcheck_runs_created_total", "Runs created", ["provider"])
DOCUMENTS_UPLOADED = Counter("reqcheck_documents_uploaded_total", "Documents uploaded", ["format"])
CHAT_MESSAGES = Counter("reqcheck_chat_messages_total", "Chat questions", ["provider", "result"])
SSE_CONNECTIONS = Gauge("reqcheck_sse_connections", "Open SSE connections", ["kind"])


class MetricsMiddleware:
    """Чистый ASGI-middleware: не буферизует SSE-ответы."""

    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        start = time.perf_counter()
        status = {"code": 500}

        async def _send(message):
            if message["type"] == "http.response.start":
                status["code"] = message["status"]
            await send(message)

        try:
            await self.app(scope, receive, _send)
        finally:
            route = scope.get("route")
            path = getattr(route, "path", None) or "unmatched"
            if path not in ("/metrics", "/livez"):
                elapsed = time.perf_counter() - start
                HTTP_REQUESTS.labels(scope["method"], path, str(status["code"])).inc()
                HTTP_LATENCY.labels(scope["method"], path).observe(elapsed)
                logging.getLogger("access").info(
                    "request", extra={"method": scope["method"], "path": scope.get("path"), "route": path,
                                      "status": status["code"], "duration_ms": round(elapsed * 1000, 1)})
