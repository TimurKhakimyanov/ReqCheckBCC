"""Критерии качества требований.

Объединённый список из ISO/IEC/IEEE 29148:2018 (п. 5.2.5 — отдельное требование, п. 5.2.6 — набор)
и IEEE Std 830-1998 (п. 4.3 — свойства хорошей SRS). Описания — собственный пересказ, не текст стандартов.
"""

from __future__ import annotations

from enum import Enum

from pydantic import BaseModel


class Criterion(str, Enum):
    # --- Отдельное требование ---
    NECESSARY = "necessary"
    IMPLEMENTATION_FREE = "implementation_free"
    UNAMBIGUOUS = "unambiguous"
    COMPLETE = "complete"
    SINGULAR = "singular"
    FEASIBLE = "feasible"
    VERIFIABLE = "verifiable"
    CORRECT = "correct"
    CONFORMING = "conforming"
    TRACEABLE = "traceable"
    # --- Набор требований ---
    SET_COMPLETE = "set_complete"
    SET_CONSISTENT = "set_consistent"
    SET_FEASIBLE = "set_feasible"
    SET_COMPREHENSIBLE = "set_comprehensible"
    SET_VALIDATABLE = "set_validatable"
    SET_RANKED = "set_ranked"
    SET_MODIFIABLE = "set_modifiable"
    SET_TRACEABLE = "set_traceable"


class CriterionInfo(BaseModel):
    code: Criterion
    level: str  # "requirement" | "set"
    title_ru: str
    title_en: str
    references: list[str]
    description_ru: str


CRITERIA: dict[Criterion, CriterionInfo] = {
    c.code: c
    for c in [
        CriterionInfo(
            code=Criterion.NECESSARY, level="requirement", title_ru="Необходимость", title_en="Necessary",
            references=["29148 5.2.5 a"],
            description_ru="Требование задаёт нужную возможность или ограничение; без него продукт неполон, "
            "а удаление ничего не ломает — признак лишнего требования.",
        ),
        CriterionInfo(
            code=Criterion.IMPLEMENTATION_FREE, level="requirement", title_ru="Без проектных решений",
            title_en="Appropriate / implementation-free", references=["29148 5.2.5 b"],
            description_ru="Требование говорит «что», а не «как»: не навязывает архитектуру, технологию, "
            "формат хранения или протокол без явной необходимости.",
        ),
        CriterionInfo(
            code=Criterion.UNAMBIGUOUS, level="requirement", title_ru="Однозначность", title_en="Unambiguous",
            references=["29148 5.2.5 c", "IEEE 830 4.3.2"],
            description_ru="Формулировку можно понять только одним способом: нет размытых слов, неопределённых "
            "терминов, неуточнённых единиц, часовых поясов, границ интервалов.",
        ),
        CriterionInfo(
            code=Criterion.COMPLETE, level="requirement", title_ru="Полнота", title_en="Complete",
            references=["29148 5.2.5 d", "IEEE 830 4.3.3"],
            description_ru="Требование не нуждается в домысливании: описаны условия, реакция на ошибки и "
            "граничные случаи, нет ссылок на «будет определено позже».",
        ),
        CriterionInfo(
            code=Criterion.SINGULAR, level="requirement", title_ru="Атомарность", title_en="Singular",
            references=["29148 5.2.5 e"],
            description_ru="Одно требование — одна возможность или ограничение; без «и/или» нескольких поведений.",
        ),
        CriterionInfo(
            code=Criterion.FEASIBLE, level="requirement", title_ru="Реализуемость", title_en="Feasible",
            references=["29148 5.2.5 f"],
            description_ru="Требование выполнимо в разумных техническом, временном и бюджетном ограничениях.",
        ),
        CriterionInfo(
            code=Criterion.VERIFIABLE, level="requirement", title_ru="Проверяемость", title_en="Verifiable",
            references=["29148 5.2.5 g", "IEEE 830 4.3.6"],
            description_ru="Существует конечный объективный способ (тест, анализ, осмотр) доказать выполнение; "
            "есть измеримые критерии.",
        ),
        CriterionInfo(
            code=Criterion.CORRECT, level="requirement", title_ru="Корректность", title_en="Correct",
            references=["29148 5.2.5 h", "IEEE 830 4.3.1"],
            description_ru="Требование точно отражает потребность заинтересованных лиц и предметную область, "
            "не содержит фактических ошибок.",
        ),
        CriterionInfo(
            code=Criterion.CONFORMING, level="requirement", title_ru="Соответствие шаблону",
            title_en="Conforming", references=["29148 5.2.5 i"],
            description_ru="Требование оформлено по принятому шаблону и стилю документа.",
        ),
        CriterionInfo(
            code=Criterion.TRACEABLE, level="requirement", title_ru="Трассируемость", title_en="Traceable",
            references=["IEEE 830 4.3.8"],
            description_ru="У требования есть идентификатор и понятен источник; на него можно сослаться "
            "из тестов и дочерних документов.",
        ),
        CriterionInfo(
            code=Criterion.SET_COMPLETE, level="set", title_ru="Полнота набора", title_en="Complete (set)",
            references=["29148 5.2.6 a", "IEEE 830 4.3.3"],
            description_ru="Набор покрывает все нужные возможности, ошибки, состояния и интерфейсы; "
            "разделы шаблона заполнены.",
        ),
        CriterionInfo(
            code=Criterion.SET_CONSISTENT, level="set", title_ru="Непротиворечивость",
            title_en="Consistent", references=["29148 5.2.6 b", "IEEE 830 4.3.4"],
            description_ru="Требования не противоречат друг другу, критериям приёмки и дочерним документам; "
            "термины и единицы используются единообразно.",
        ),
        CriterionInfo(
            code=Criterion.SET_FEASIBLE, level="set", title_ru="Реализуемость набора",
            title_en="Feasible (set)", references=["29148 5.2.6 c"],
            description_ru="Набор целиком выполним в рамках ограничений проекта.",
        ),
        CriterionInfo(
            code=Criterion.SET_COMPREHENSIBLE, level="set", title_ru="Понятность",
            title_en="Comprehensible", references=["29148 5.2.6 d"],
            description_ru="Из набора ясно, что ожидается от системы и как она связана со своим окружением.",
        ),
        CriterionInfo(
            code=Criterion.SET_VALIDATABLE, level="set", title_ru="Валидируемость",
            title_en="Able to be validated", references=["29148 5.2.6 e"],
            description_ru="Можно доказать, что выполнение набора удовлетворит бизнес-потребность.",
        ),
        CriterionInfo(
            code=Criterion.SET_RANKED, level="set", title_ru="Ранжированность", title_en="Ranked",
            references=["IEEE 830 4.3.5"],
            description_ru="Для требований указаны важность и/или стабильность.",
        ),
        CriterionInfo(
            code=Criterion.SET_MODIFIABLE, level="set", title_ru="Модифицируемость", title_en="Modifiable",
            references=["IEEE 830 4.3.7"],
            description_ru="Структура документа позволяет вносить изменения без дублирования; есть версия.",
        ),
        CriterionInfo(
            code=Criterion.SET_TRACEABLE, level="set", title_ru="Трассируемость набора",
            title_en="Traceable (set)", references=["IEEE 830 4.3.8"],
            description_ru="Связи между требованиями, критериями приёмки и дочерними документами прослеживаются.",
        ),
    ]
}

REQUIREMENT_CRITERIA = [c for c, info in CRITERIA.items() if info.level == "requirement"]
SET_CRITERIA = [c for c, info in CRITERIA.items() if info.level == "set"]
