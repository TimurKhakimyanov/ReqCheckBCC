"""События прогресса прогона. Ядро вызывает callback, воркер публикует в Redis, API отдаёт по SSE."""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime, timezone
from enum import Enum

from pydantic import BaseModel, Field


class RunStage(str, Enum):
    QUEUED = "queued"
    PARSING = "parsing"
    SEGMENTING = "segmenting"
    RULE_CHECKS = "rule_checks"
    CHECKING_REQUIREMENTS = "checking_requirements"
    CHECKING_SET = "checking_set"
    VERIFYING = "verifying"
    RENDERING = "rendering"
    DONE = "done"
    FAILED = "failed"
    CANCELLED = "cancelled"


class ProgressEvent(BaseModel):
    run_id: str | None = None
    stage: RunStage
    progress: float = Field(ge=0.0, le=1.0, description="Общий прогресс 0..1")
    message: str = ""
    current: int | None = None
    total: int | None = None
    ts: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


ProgressCallback = Callable[[ProgressEvent], None]
