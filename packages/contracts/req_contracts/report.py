"""Модель отчёта о проверке требований.

Это общий контракт между ядром агента (packages/core), воркером, API и веб-интерфейсом.
Менять только согласованно: поднимите SCHEMA_VERSION и опишите изменение в docs/architecture.md.
"""

from __future__ import annotations

from datetime import datetime
from enum import Enum

from pydantic import BaseModel, Field

from .criteria import Criterion

SCHEMA_VERSION = "1.1"  # 1.1: уточняющие вопросы автору (Report.questions)


class Severity(str, Enum):
    CRITICAL = "critical"  # непроверяемое, противоречивое, неполное — блокирует разработку
    MAJOR = "major"  # существенный дефект, исправить до тестирования
    MINOR = "minor"  # стилистика, оформление


class CheckVerdict(str, Enum):
    PASS = "pass"
    FAIL = "fail"
    NOT_APPLICABLE = "not_applicable"


class RequirementKind(str, Enum):
    FUNCTIONAL = "functional"
    NON_FUNCTIONAL = "non_functional"
    DATA = "data"
    INTEGRATION = "integration"
    API = "api"
    UI = "ui"
    ACCEPTANCE = "acceptance"  # строка критериев приёмки
    OTHER = "other"


class FindingScope(str, Enum):
    REQUIREMENT = "requirement"  # дефект одного требования
    SET = "set"  # дефект набора (противоречие между требованиями, пропуск, оформление документа)


class FindingSource(str, Enum):
    LLM = "llm"
    RULE = "rule"  # детерминированная проверка без LLM (словарь размытых слов, пустые поля шаблона и т. п.)


class DocumentFormat(str, Enum):
    PDF = "pdf"
    DOCX = "docx"
    MD = "md"
    TXT = "txt"


class ParsedDocument(BaseModel):
    """Нормализованный текст документа. Все смещения в отчёте считаются от `text`."""

    name: str
    format: DocumentFormat
    sha256: str
    text: str
    page_offsets: list[int] | None = Field(
        default=None, description="Смещение начала каждой страницы в `text` (только для PDF)"
    )


class SourceLocation(BaseModel):
    """Ссылка на конкретное место документа. Каждое нарушение обязано иметь хотя бы одну."""

    section: str = Field(description="Путь раздела, напр. «Часть A › Функциональные требования»")
    quote: str = Field(description="Дословная цитата из документа")
    char_start: int | None = Field(default=None, description="Смещение цитаты в ParsedDocument.text")
    char_end: int | None = None
    page: int | None = Field(default=None, description="Номер страницы с 1 (для PDF)")
    verified: bool = Field(
        default=False, description="Цитата найдена в тексте документа кодом (защита от галлюцинаций)"
    )


class Requirement(BaseModel):
    id: str = Field(description="Идентификатор в отчёте: R-001, R-002…; подтребования R-002.1")
    source_id: str | None = Field(default=None, description="Идентификатор в документе (Ф-1), если был")
    parent_id: str | None = Field(default=None, description="Для атомарного подтребования — id составного")
    kind: RequirementKind
    summary: str = Field(description="Краткая формулировка для таблицы нарезки")
    location: SourceLocation


class CriterionCheck(BaseModel):
    criterion: Criterion
    verdict: CheckVerdict
    comment: str | None = None
    finding_ids: list[str] = Field(default_factory=list)


class RequirementAssessment(BaseModel):
    requirement_id: str
    checks: list[CriterionCheck]


class SetAssessment(BaseModel):
    checks: list[CriterionCheck]


class Finding(BaseModel):
    id: str = Field(description="D-001, D-002…")
    scope: FindingScope
    requirement_ids: list[str] = Field(default_factory=list)
    criterion: Criterion
    severity: Severity
    title: str
    explanation: str
    locations: list[SourceLocation] = Field(min_length=1)
    suggestion: str | None = Field(default=None, description="Предлагаемая исправленная формулировка")
    source: FindingSource = FindingSource.LLM


class ChecklistAnswer(str, Enum):
    YES = "yes"
    NO = "no"
    NOT_REQUIRED = "not_required"


class ChecklistItem(BaseModel):
    """Ответ агента на пункт чек-листа «Ревью требований» из шаблона документа (если он есть)."""

    question: str
    answer: ChecklistAnswer
    comment: str
    finding_ids: list[str] = Field(default_factory=list)


class QuestionPriority(str, Enum):
    BLOCKER = "blocker"  # без ответа нельзя начинать разработку или тестирование этой части
    IMPORTANT = "important"  # ответить до завершения разработки
    MINOR = "minor"  # желательно


class ClarifyingQuestion(BaseModel):
    """Уточняющий вопрос автору документа: закрытый, с вариантами ответа и ссылками на дефекты."""

    id: str = Field(description="Q-01, Q-02…")
    question: str
    why: str = Field(description="Что заблокировано без ответа")
    addressee: str = Field(default="Аналитик", description="Кто отвечает: Business owner, Product owner, Аналитик…")
    priority: QuestionPriority = QuestionPriority.IMPORTANT
    finding_ids: list[str] = Field(default_factory=list)
    options: list[str] = Field(default_factory=list, description="2–4 варианта ответа, между которыми выбирает автор")


class RunPassport(BaseModel):
    document_name: str
    document_sha256: str
    run_at: datetime
    provider: str
    model: str
    agent_version: str = Field(description="git commit или тег агента")
    standards: list[str] = Field(
        default_factory=lambda: ["ISO/IEC/IEEE 29148:2018 п. 5.2.5, 5.2.6", "IEEE Std 830-1998 п. 4.3"]
    )


class Summary(BaseModel):
    requirements_total: int
    findings_total: int
    by_severity: dict[Severity, int]
    critical_finding_ids: list[str]


class Conclusion(BaseModel):
    ready_for_development: bool
    ready_for_testing: bool
    rationale: str
    top_fixes: list[str] = Field(description="Что исправить в первую очередь, по порядку; со ссылками на D-xxx")


class Usage(BaseModel):
    llm_calls: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cost_usd: float | None = None
    duration_s: float | None = None


class Report(BaseModel):
    schema_version: str = SCHEMA_VERSION
    passport: RunPassport
    document: ParsedDocument
    requirements: list[Requirement]
    requirement_assessments: list[RequirementAssessment]
    set_assessment: SetAssessment
    findings: list[Finding]
    checklist: list[ChecklistItem] = Field(default_factory=list)
    questions: list[ClarifyingQuestion] = Field(default_factory=list)
    summary: Summary
    conclusion: Conclusion
    usage: Usage = Field(default_factory=Usage)
