"""Журнал прогона в Postgres (таблица run_logs) — для дерева логов на странице аудита.

Что попадает: события агентов (ProgressEvent), логи ядра (`req_core.*`, в т. ч. строка на каждый вызов LLM)
и воркера (`worker.*`). Прогон определяется по contextvar: execute_run ставит его в своём потоке, ядро
переносит контекст в свои пулы потоков (`req_core.pipeline._ctx_map`), watchdog — в поток ядра.
Записи копятся в памяти и сбрасываются пачками (не чаще раза в секунду и в конце прогона).
Сбой записи журнала никогда не роняет прогон.
"""

from __future__ import annotations

import contextvars
import logging
import threading
import time
import traceback
import uuid
from datetime import datetime, timezone
from typing import Any

from app.db import SessionLocal
from app.logging_setup import _RESERVED
from app.models import RunLog
from req_contracts import ProgressEvent

log = logging.getLogger("worker.runlog")  # собственные сообщения журнала в журнал не пишутся

CURRENT: contextvars.ContextVar[RunLogSink | None] = contextvars.ContextVar("reqcheck_run_log", default=None)

MAX_ENTRIES = 5000  # на прогон; дальше — одна запись «журнал обрезан»
FLUSH_INTERVAL_S = 1.0
MAX_MESSAGE = 4000
MAX_EXC = 8000
# Сообщения воркера для Loki — по-английски; в журнале прогона показываем по-русски
WORKER_MESSAGES = {
    "run failed": "Прогон завершился ошибкой",
    "export failed": "Не удалось выгрузить отчёт",
    "indexing failed": "Не удалось проиндексировать отчёт для поиска",
    "knowledge search failed": "Поиск по базе знаний не удался",
    "run was interrupted (worker restart?); starting over": "Прогон был прерван (перезапуск воркера?) — начинаем заново",
    "redis publish failed": "Не удалось опубликовать событие в Redis",
}


def _source(logger_name: str) -> str:
    if logger_name.startswith("req_core.llm"):
        return "llm"
    if logger_name.startswith("req_core"):
        return "core"
    if logger_name.startswith("worker"):
        return "worker"
    return "system"


def _jsonable(v: Any) -> Any:
    if v is None or isinstance(v, (bool, int, float, str)):
        return v
    if isinstance(v, (list, tuple)):
        return [_jsonable(x) for x in v][:50]
    if isinstance(v, dict):
        return {str(k): _jsonable(x) for k, x in list(v.items())[:50]}
    return str(v)[:500]


class RunLogSink:
    def __init__(self, run_id: str):
        self.rid = uuid.UUID(run_id)
        self.stage: str | None = "queued"
        self._buf: list[dict[str, Any]] = []
        self._lock = threading.Lock()
        self._flush_lock = threading.Lock()
        self._count = 0
        self._truncated = False
        self._last_flush = time.monotonic()
        self._last_progress: tuple | None = None
        self.closed = False

    def add(self, level: str, source: str, message: str, *, stage: str | None = None, current: int | None = None,
            total: int | None = None, data: dict[str, Any] | None = None) -> None:
        with self._lock:
            if self.closed:
                return
            if self._count >= MAX_ENTRIES:
                if not self._truncated:
                    self._truncated = True
                    self._buf.append(self._row("warning", "worker", f"Журнал обрезан: больше {MAX_ENTRIES} записей",
                                               self.stage, None, None, {}))
                return
            self._count += 1
            self._buf.append(self._row(level, source, message, stage or self.stage, current, total, data or {}))

    def _row(self, level: str, source: str, message: str, stage: str | None, current: int | None,
             total: int | None, data: dict[str, Any]) -> dict[str, Any]:
        return {"run_id": self.rid, "ts": datetime.now(timezone.utc), "level": level, "source": source,
                "stage": stage, "message": message[:MAX_MESSAGE], "current": current, "total": total,
                "data": _jsonable(data)}

    def progress(self, event: ProgressEvent) -> None:
        """Событие агента. Повтор того же сообщения (heartbeat, тот же счётчик) не пишется."""
        key = (event.stage.value, event.message, event.current, event.total)
        with self._lock:
            self.stage = event.stage.value
            if key == self._last_progress:
                return
            self._last_progress = key
        if event.message:
            self.add("error" if event.stage.value == "failed" else "info", "progress", event.message,
                     stage=event.stage.value, current=event.current, total=event.total,
                     data={"progress": event.progress})
        self.maybe_flush()

    def maybe_flush(self) -> None:
        if time.monotonic() - self._last_flush >= FLUSH_INTERVAL_S:
            self.flush()

    def flush(self) -> None:
        with self._flush_lock:
            with self._lock:
                rows, self._buf = self._buf, []
                self._last_flush = time.monotonic()
            if not rows:
                return
            try:
                with SessionLocal() as db:
                    db.bulk_insert_mappings(RunLog, rows)
                    db.commit()
            except Exception:  # noqa: BLE001 — прогон удалён (FK) или БД недоступна: журнал не важнее прогона
                log.warning("run log flush failed", extra={"run_id": str(self.rid), "rows": len(rows)}, exc_info=True)

    def close(self) -> None:
        self.flush()
        with self._lock:
            self.closed = True


class RunLogHandler(logging.Handler):
    """Пишет записи логгеров в журнал текущего прогона (если он есть в контексте)."""

    def emit(self, record: logging.LogRecord) -> None:
        sink = CURRENT.get()
        if sink is None or record.name.startswith("worker.runlog"):
            return
        if record.name == "worker.tasks" and record.levelno < logging.WARNING:
            return  # «run started/finished» для Loki; в журнал воркер пишет свои строки по-русски
        try:
            data = {k: v for k, v in record.__dict__.items()
                    if k not in _RESERVED and not k.startswith("_") and k != "run_id"}
            data["logger"] = record.name
            if record.exc_info and record.exc_info[1] is not None:
                data["exc"] = "".join(traceback.format_exception(*record.exc_info))[-MAX_EXC:]
            message = record.getMessage()
            if record.name.startswith("worker.") and message in WORKER_MESSAGES:
                message = WORKER_MESSAGES[message]
                if isinstance(data.get("error"), str):
                    message = f"{message}: {data['error']}"
                elif isinstance(data.get("format"), str):
                    message = f"{message} ({data['format'].upper()})"
            sink.add(record.levelname.lower(), _source(record.name), message, data=data)
        except Exception:  # noqa: BLE001
            self.handleError(record)


_handler = RunLogHandler(level=logging.INFO)
_install_lock = threading.Lock()


def install() -> None:
    """Подключить обработчик к корневому логгеру (идемпотентно)."""
    root = logging.getLogger()
    with _install_lock:
        if _handler not in root.handlers:
            root.addHandler(_handler)
