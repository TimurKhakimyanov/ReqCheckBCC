"""Pydantic-схемы ответов LLM. Все поля со значениями по умолчанию — пустой ответ тоже валиден (FakeLLM)."""

from __future__ import annotations

from pydantic import BaseModel, Field
from req_contracts import CheckVerdict, ChecklistAnswer, Criterion, RequirementKind, Severity


class SegPart(BaseModel):
    quote: str = Field(default="", description="Дословный фрагмент документа — атомарная часть требования")
    summary: str = Field(default="", description="Краткая формулировка части, до 15 слов")


class SegRequirement(BaseModel):
    source_id: str = Field(default="", description="Идентификатор в документе (например «Ф-1»); пусто, если нет")
    kind: RequirementKind = RequirementKind.FUNCTIONAL
    quote: str = Field(default="", description="Дословный полный текст требования из документа")
    summary: str = Field(default="", description="Краткая формулировка, до 15 слов")
    parts: list[SegPart] = Field(default_factory=list, description="Атомарные части, если требование составное")


class SegmentationResult(BaseModel):
    requirements: list[SegRequirement] = Field(default_factory=list)


class Issue(BaseModel):
    requirement_ids: list[str] = Field(default_factory=list, description="R-xxx, к которым относится дефект")
    criterion: Criterion = Criterion.UNAMBIGUOUS
    severity: Severity = Severity.MAJOR
    title: str = Field(default="", description="Суть дефекта, до 12 слов")
    explanation: str = Field(default="", description="Что не так и чем это мешает разработке/тестированию")
    quotes: list[str] = Field(default_factory=list, description="1–3 дословные цитаты из документа")
    suggestion: str = Field(default="", description="Исправленная формулировка или что добавить")


class RequirementNA(BaseModel):
    requirement_id: str = ""
    not_applicable: list[Criterion] = Field(default_factory=list)


class RequirementBatchResult(BaseModel):
    issues: list[Issue] = Field(default_factory=list)
    not_applicable: list[RequirementNA] = Field(default_factory=list)


class SetCheck(BaseModel):
    criterion: Criterion = Criterion.SET_COMPLETE
    verdict: CheckVerdict = CheckVerdict.PASS
    comment: str = ""


class SetConsistencyResult(BaseModel):
    issues: list[Issue] = Field(default_factory=list)


class SetReviewResult(BaseModel):
    issues: list[Issue] = Field(default_factory=list)
    checks: list[SetCheck] = Field(default_factory=list)


class CriticVerdict(BaseModel):
    finding_id: str = ""
    keep: bool = True
    severity: str = Field(default="", description="Новая критичность critical|major|minor или пусто — без изменений")
    reason: str = ""


class CriticResult(BaseModel):
    verdicts: list[CriticVerdict] = Field(default_factory=list)


class ChecklistLLMItem(BaseModel):
    index: int = 0
    answer: ChecklistAnswer = ChecklistAnswer.NO
    comment: str = ""
    finding_ids: list[str] = Field(default_factory=list)


class ChecklistResult(BaseModel):
    items: list[ChecklistLLMItem] = Field(default_factory=list)


class ConclusionResult(BaseModel):
    rationale: str = ""
    top_fixes: list[str] = Field(default_factory=list)
