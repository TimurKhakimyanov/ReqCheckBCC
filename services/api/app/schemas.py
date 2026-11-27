"""Модели запросов и ответов HTTP API (docs/api.md)."""

from __future__ import annotations

import json
from datetime import date, datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, BeforeValidator, Field, field_validator
from req_contracts import Finding, ProviderName, RunStage, Severity, Summary, Usage, ValidationOptions

ReviewStatus = Literal["open", "accepted", "false_positive", "fixed"]


class RunSummary(Summary):
    """Report.summary + Report.conclusion.ready_for_development (для списков прогонов и документов)."""

    ready_for_development: bool | None = None
    ready_for_testing: bool | None = None

    @field_validator("by_severity")
    @classmethod
    def _all_severities(cls, v: dict[Severity, int]) -> dict[Severity, int]:
        return {s: int(v.get(s, 0)) for s in Severity}


class ErrorOut(BaseModel):
    detail: str
    code: str


# --- auth ---
class LoginIn(BaseModel):
    username: str
    password: str


class UserOut(BaseModel):
    id: str
    username: str
    role: Literal["admin"] = "admin"
    locale: str


class PasswordChange(BaseModel):
    current: str
    new: str = Field(min_length=8)


class UserPatch(BaseModel):
    locale: str | None = Field(default=None, max_length=8)
    password: PasswordChange | None = None


# --- providers ---
class ProviderOut(BaseModel):
    provider: ProviderName
    enabled: bool
    has_key: bool
    key_hint: str | None
    base_url: str | None
    default_model: str | None
    extra_body: dict[str, Any] | None = None
    extra_body_set_review: dict[str, Any] | None = None
    max_output_tokens: int | None = None
    updated_at: datetime | None


def _json_object(value: Any) -> Any:
    """Принимает объект или строку с JSON-объектом (из текстового поля формы)."""
    if isinstance(value, str):
        try:
            value = json.loads(value) if value.strip() else None
        except json.JSONDecodeError as e:
            raise ValueError(f"невалидный JSON: {e.msg}") from e
    if value is not None and not isinstance(value, dict):
        raise ValueError("ожидается JSON-объект {...}")
    return value


JsonObject = Annotated[dict[str, Any], BeforeValidator(_json_object)]


class ProviderUpdate(BaseModel):
    """Передаются только меняемые поля. Для extra_body, extra_body_set_review, max_output_tokens null — сбросить."""

    api_key: str | None = Field(default=None, description="Пустая строка — удалить ключ")
    base_url: str | None = None
    enabled: bool | None = None
    default_model: str | None = None
    extra_body: JsonObject | None = Field(
        default=None, description='Доп. поля тела запроса, напр. {"chat_template_kwargs": {"enable_thinking": false}}')
    extra_body_set_review: JsonObject | None = Field(
        default=None, description="extra_body для проверки набора требований (None — как extra_body)")
    max_output_tokens: int | None = Field(default=None, ge=1, le=1_000_000)


class ProviderTestIn(BaseModel):
    """Несохранённые значения из формы; проверяются поверх сохранённых и не записываются."""

    api_key: str | None = None
    base_url: str | None = None
    extra_body: JsonObject | None = None


class ProviderTestOut(BaseModel):
    ok: bool
    latency_ms: int
    error: str | None = None
    models: list[str] = Field(default_factory=list, description="Модели, доступные с этими ключом и адресом")


class ModelsOut(BaseModel):
    models: list[str]
    error: str | None = None


# --- documents & runs ---
class RunShort(BaseModel):
    id: str
    status: RunStage
    progress: float
    created_at: datetime
    finished_at: datetime | None = None
    summary: RunSummary | None = None


class DocumentOut(BaseModel):
    id: str
    name: str
    format: str
    size_bytes: int
    sha256: str
    created_at: datetime
    runs_count: int
    last_run: RunShort | None = None


class DocumentList(BaseModel):
    items: list[DocumentOut]
    total: int


class RunCreate(BaseModel):
    document_id: str
    provider: ProviderName | None = None
    model: str | None = None
    options: ValidationOptions | None = None


class RunOut(BaseModel):
    id: str
    document_id: str
    document_name: str
    status: RunStage
    stage: RunStage
    progress: float
    message: str = ""
    provider: str
    model: str
    options: dict[str, Any]
    created_at: datetime
    started_at: datetime | None = None
    finished_at: datetime | None = None
    error: str | None = None
    usage: Usage | None = None
    summary: RunSummary | None = None


class RunList(BaseModel):
    items: list[RunOut]
    total: int


class FindingReviewOut(BaseModel):
    finding_id: str
    status: ReviewStatus
    comment: str | None = None
    updated_at: datetime | None = None


class FindingReviewIn(BaseModel):
    status: ReviewStatus
    comment: str | None = None


class FindingWithReview(BaseModel):
    finding: Finding
    review: FindingReviewOut


# --- chat ---
class ChatMessageOut(BaseModel):
    id: str
    role: Literal["user", "assistant"]
    content: str
    created_at: datetime


class ChatIn(BaseModel):
    message: str = Field(min_length=1, max_length=8000)
    provider: ProviderName | None = None
    model: str | None = None


# --- search & knowledge ---
class SearchHit(BaseModel):
    score: float
    kind: Literal["requirement", "finding"]
    text: str
    run_id: str
    document_name: str
    requirement_id: str | None = None
    finding_id: str | None = None


class KnowledgeItemOut(BaseModel):
    id: str
    title: str
    source: Literal["builtin", "upload", "manual"]
    chunks: int
    status: Literal["indexing", "ready", "failed"]
    created_at: datetime
    error: str | None = None


class KnowledgeIn(BaseModel):
    title: str = Field(min_length=1, max_length=500)
    text: str = Field(min_length=1)


# --- service ---
class HealthOut(BaseModel):
    status: Literal["ok", "degraded"]
    version: str
    checks: dict[str, str]
    limits: dict[str, int] = Field(default_factory=dict, description="Ограничения для клиента: max_upload_mb")


class UsageRow(BaseModel):
    runs: int = 0
    llm_calls: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cost_usd: float = 0.0
    duration_s: float = 0.0


class UsageByProvider(UsageRow):
    provider: str
    model: str


class UsageByDay(UsageRow):
    date: date


class UsageOut(BaseModel):
    totals: UsageRow
    by_provider: list[UsageByProvider]
    by_day: list[UsageByDay]


class AuditEntry(BaseModel):
    id: int
    ts: datetime
    actor: str
    action: str
    target: str | None
    details: dict[str, Any]


class AuditList(BaseModel):
    items: list[AuditEntry]
    total: int
