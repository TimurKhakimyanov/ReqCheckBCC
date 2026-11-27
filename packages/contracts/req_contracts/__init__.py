"""Общие контракты ReqCheck: модели отчёта, критерии, события прогресса, конфигурация LLM."""

from .criteria import CRITERIA, REQUIREMENT_CRITERIA, SET_CRITERIA, Criterion, CriterionInfo
from .events import ProgressCallback, ProgressEvent, RunStage
from .llm import EmbeddingProviderName, ProviderConfig, ProviderName, ValidationOptions
from .report import (
    SCHEMA_VERSION,
    CheckVerdict,
    ChecklistAnswer,
    ChecklistItem,
    ClarifyingQuestion,
    Conclusion,
    CriterionCheck,
    Decision,
    DefectType,
    DocumentFormat,
    Finding,
    FixItem,
    Grounding,
    QualityStats,
    QuestionResolution,
    RequirementRewrite,
    SkippedFragment,
    FindingScope,
    FindingSource,
    ParsedDocument,
    QuestionPriority,
    Report,
    Requirement,
    RequirementAssessment,
    RequirementKind,
    RunPassport,
    SetAssessment,
    Severity,
    SourceLocation,
    Summary,
    Usage,
)

__all__ = [
    "CRITERIA", "REQUIREMENT_CRITERIA", "SET_CRITERIA", "SCHEMA_VERSION",
    "Criterion", "CriterionInfo", "ProgressCallback", "ProgressEvent", "RunStage",
    "EmbeddingProviderName", "ProviderConfig", "ProviderName", "ValidationOptions",
    "CheckVerdict", "ChecklistAnswer", "ChecklistItem", "ClarifyingQuestion", "Conclusion", "CriterionCheck",
    "DocumentFormat", "Finding", "FindingScope", "FindingSource", "ParsedDocument", "QuestionPriority", "Report",
    "Requirement", "RequirementAssessment", "RequirementKind", "RunPassport", "SetAssessment", "Severity",
    "SourceLocation", "Summary", "Usage", "Decision", "DefectType", "FixItem", "Grounding", "QualityStats",
    "QuestionResolution", "RequirementRewrite", "SkippedFragment",
]
