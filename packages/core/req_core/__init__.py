"""Ядро агента ReqCheck — публичный интерфейс.

Сигнатуры зафиксированы (см. docs/architecture.md). Воркер, API и CLI импортируют только то, что объявлено здесь.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from datetime import datetime
from pathlib import Path
from typing import Literal, Protocol

from pydantic import BaseModel
from req_contracts import ClarifyingQuestion, ParsedDocument, ProgressCallback, ProviderConfig, Report, ValidationOptions

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
    from .parsing import parse_document as _parse

    return _parse(Path(path), name=name)


def validate_document(
    path: Path,
    llm: ProviderConfig,
    *,
    options: ValidationOptions | None = None,
    on_progress: ProgressCallback | None = None,
    document_name: str | None = None,
    ask_author: Callable[[list[ClarifyingQuestion]], dict[str, str]] | None = None,
) -> Report:
    """ask_author — ответы автора по ходу прогона (веб-аналог --ask): при options.ask_author ядро останавливается
    на вопросах, передаёт их сюда и ждёт {Q-01: ответ}; пустой dict — продолжить без ответов."""
    from req_contracts import ProgressEvent, RunStage

    from .pipeline import run_pipeline

    if on_progress:
        on_progress(ProgressEvent(stage=RunStage.PARSING, progress=0.01, message="Чтение документа"))
    doc = parse_document(Path(path), name=document_name)
    client = get_llm(llm)
    return run_pipeline(doc, client, options=options, on_progress=on_progress,
                        provider=llm.provider.value, model=getattr(client, "model", llm.model), ask_author=ask_author)


def render_report(report: Report, fmt: ReportFormat) -> bytes:
    from .render import render_report as _render

    return _render(report, fmt)


def get_llm(cfg: ProviderConfig) -> LLMClient:
    from .llm import create_llm

    return create_llm(cfg)


def list_models(cfg: ProviderConfig) -> list[str]:
    from .llm import list_provider_models

    return list_provider_models(cfg)


def answer_question(
    report: Report,
    history: list[ChatMessage],
    question: str,
    llm: ProviderConfig,
    knowledge_snippets: list[str] | None = None,
) -> Iterator[str]:
    from .chat import answer_stream

    return answer_stream(get_llm(llm), report, history, question, knowledge_snippets)


__all__ = [
    "ChatMessage", "LLMClient", "ReportFormat", "answer_question", "get_llm", "list_models",
    "parse_document", "render_report", "validate_document",
]
