"""Ядро агента ReqCheck — публичный интерфейс.

ЗАГЛУШКА: сигнатуры зафиксированы (см. docs/architecture.md), реализация — сессия «Ядро».
Воркер, API и CLI импортируют только то, что объявлено здесь. До готовности ядра в их тестах
эти функции подменяются моками, возвращающими req_contracts/fixtures/sample_report.json.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import datetime
from pathlib import Path
from typing import Literal, Protocol

from pydantic import BaseModel
from req_contracts import ParsedDocument, ProgressCallback, ProviderConfig, Report, ValidationOptions

__version__ = "0.1.0"

ReportFormat = Literal["md", "json", "docx", "pdf"]


class ChatMessage(BaseModel):
    role: Literal["user", "assistant", "system"]
    content: str
    created_at: datetime | None = None


class LLMClient(Protocol):
    def complete(self, system: str, user: str) -> str: ...
    def stream(self, system: str, messages: list[ChatMessage]) -> Iterator[str]: ...
    def complete_json(self, system: str, user: str, schema: type[BaseModel]) -> BaseModel: ...


def parse_document(path: Path, *, name: str | None = None) -> ParsedDocument:
    raise NotImplementedError


def validate_document(
    path: Path,
    llm: ProviderConfig,
    *,
    options: ValidationOptions | None = None,
    on_progress: ProgressCallback | None = None,
    document_name: str | None = None,
) -> Report:
    raise NotImplementedError


def render_report(report: Report, fmt: ReportFormat) -> bytes:
    raise NotImplementedError


def get_llm(cfg: ProviderConfig) -> LLMClient:
    raise NotImplementedError


def list_models(cfg: ProviderConfig) -> list[str]:
    raise NotImplementedError


def answer_question(
    report: Report,
    history: list[ChatMessage],
    question: str,
    llm: ProviderConfig,
    knowledge_snippets: list[str] | None = None,
) -> Iterator[str]:
    raise NotImplementedError


__all__ = [
    "ChatMessage", "LLMClient", "ReportFormat", "answer_question", "get_llm", "list_models",
    "parse_document", "render_report", "validate_document",
]
