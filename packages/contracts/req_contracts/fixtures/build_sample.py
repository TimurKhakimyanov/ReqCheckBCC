"""Собирает пример отчёта по samples/requirements.md и JSON Schema отчёта.

Нужен как фикстура для тестов API/воркера и моков веб-интерфейса — до того, как готово ядро агента.
Это НЕ результат работы агента. Запуск (в Docker):
    docker compose --profile test run --rm test-contracts python -m req_contracts.fixtures.build_sample
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

from req_contracts import (
    REQUIREMENT_CRITERIA,
    SET_CRITERIA,
    CheckVerdict,
    ChecklistAnswer,
    ChecklistItem,
    ClarifyingQuestion,
    Conclusion,
    Criterion,
    CriterionCheck,
    Decision,
    DefectType,
    DocumentFormat,
    Finding,
    FindingScope,
    FindingSource,
    FixItem,
    Grounding,
    ParsedDocument,
    QualityStats,
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

HERE = Path(__file__).parent
SAMPLE_DOC = Path("/repo/samples/requirements.md")


def loc(text: str, section: str, quote: str) -> SourceLocation:
    start = text.find(quote)
    if start < 0:
        raise ValueError(f"Цитата не найдена в документе: {quote!r}")
    return SourceLocation(section=section, quote=quote, char_start=start, char_end=start + len(quote), verified=True)


def build(text: str) -> Report:
    fr = "Часть A › Функциональные требования"
    req = [
        Requirement(id="R-001", source_id="Ф-1", kind=RequirementKind.FUNCTIONAL,
                    summary="Держатель активной карты KZT задаёт целый порог; по умолчанию выключено",
                    location=loc(text, fr, "Держатель активной карты KZT задаёт целый порог")),
        Requirement(id="R-002", source_id="Ф-2", kind=RequirementKind.FUNCTIONAL,
                    summary="Правила учёта расходов месяца: дата покупки, возвраты, исключения",
                    location=loc(text, fr, "Месяц определяется по дате совершения покупки в Алматы.")),
        Requirement(id="R-003", source_id="Ф-3", kind=RequirementKind.FUNCTIONAL,
                    summary="Push при переходе через порог, не более одного в месяц",
                    location=loc(text, fr, "Когда расходы переходят от суммы ниже порога к сумме, равной порогу или выше, клиент получает push.")),
        Requirement(id="R-004", source_id="Ф-4", kind=RequirementKind.FUNCTIONAL,
                    summary="Смена порога сохраняет накопленную сумму",
                    location=loc(text, fr, "При изменении порога накопленная сумма сохраняется.")),
        Requirement(id="R-005", source_id=None, kind=RequirementKind.NON_FUNCTIONAL,
                    summary="Передача push на отправку в течение минуты",
                    location=loc(text, "Часть A › Нефункциональные требования",
                                 "Сервис передаёт push на отправку в течение минуты после получения события.")),
        Requirement(id="R-006", source_id=None, kind=RequirementKind.API,
                    summary="Метод сохранения порога AlertsController",
                    location=loc(text, "Часть B › Общие параметры", "Сохранение порога. Функциональные требования: чтение порога")),
    ]

    findings = [
        Finding(id="D-001", scope=FindingScope.SET, requirement_ids=["R-002"], criterion=Criterion.SET_CONSISTENT,
                severity=Severity.CRITICAL, title="Критерий приёмки противоречит правилу определения месяца",
                explanation="Ф-2 относит покупку к месяцу по дате совершения, а критерий приёмки ожидает рост "
                "февральского счётчика для покупки, совершённой 31 января.",
                locations=[loc(text, "Часть A › Функциональные требования", "Месяц определяется по дате совершения покупки в Алматы."),
                           loc(text, "Часть A › Критерии приемки", "Февральский счётчик вырос")],
                suggestion="Уточнить, какая дата определяет месяц (совершения или проведения), и привести критерий приёмки в соответствие."),
        Finding(id="D-002", scope=FindingScope.SET, requirement_ids=["R-003", "R-004"], criterion=Criterion.SET_CONSISTENT,
                severity=Severity.CRITICAL, title="Лимит одного push в месяц противоречит Ф-4",
                explanation="Ф-3 разрешает не более одного push за месяц, а Ф-4 требует push «независимо от истории» после смены порога.",
                locations=[loc(text, "Часть A › Функциональные требования", "На карту приходится максимум один такой push за календарный месяц."),
                           loc(text, "Часть A › Функциональные требования", "следующее достижение вызывает push независимо от истории предыдущей настройки")],
                suggestion="Явно указать, сбрасывается ли лимит одного push при изменении порога."),
        Finding(id="D-003", scope=FindingScope.REQUIREMENT, requirement_ids=["R-002"], criterion=Criterion.UNAMBIGUOUS,
                severity=Severity.MAJOR, title="Не определены часовой пояс и статус «проведённой» покупки",
                explanation="«В Алматы» не задаёт смещение UTC явно; не определено, какие статусы операции считаются проведёнными.",
                locations=[loc(text, "Часть A › Функциональные требования", "В расходы входят проведённые покупки.")],
                suggestion="Указать часовой пояс как смещение UTC и перечислить статусы операций, входящих в расходы."),
        Finding(id="D-004", scope=FindingScope.SET, requirement_ids=[], criterion=Criterion.SET_CONSISTENT,
                severity=Severity.MAJOR, title="Разные единицы суммы покупки и порога",
                explanation="Сумма покупки хранится в тиынах, порог — в тенге; правило сравнения не описано.",
                locations=[loc(text, "Часть A › Требования к данным", "сумму покупки в тиынах, признак отправки и порог в тенге")],
                suggestion="Хранить обе величины в одной единице или описать правило конвертации и округления."),
        Finding(id="D-005", scope=FindingScope.REQUIREMENT, requirement_ids=["R-006"], criterion=Criterion.CORRECT,
                severity=Severity.CRITICAL, title="Метод сохранения описан как GET и как чтение",
                explanation="Description одновременно говорит о сохранении и чтении; для изменения состояния выбран GET.",
                locations=[loc(text, "Часть B › Общие параметры", "Сохранение порога. Функциональные требования: чтение порога"),
                           loc(text, "Часть B › Общие параметры", "| **REST type** | GET |")],
                suggestion="Разделить чтение (GET) и сохранение (PUT/POST) порога в два метода."),
        Finding(id="D-006", scope=FindingScope.REQUIREMENT, requirement_ids=["R-005"], criterion=Criterion.VERIFIABLE,
                severity=Severity.MAJOR, title="Время доставки без условий измерения",
                explanation="Не указаны перцентиль, нагрузка и точка отсчёта/окончания измерения.",
                locations=[loc(text, "Часть A › Нефункциональные требования", "в течение минуты после получения события")],
                suggestion="Например: «95% событий передаются в сервис push не позднее 60 с при нагрузке до N событий/с»."),
        Finding(id="D-007", scope=FindingScope.SET, requirement_ids=[], criterion=Criterion.SET_MODIFIABLE,
                severity=Severity.MINOR, title="Не указаны версия и дата документа", source=FindingSource.RULE,
                explanation="Версия документа не зафиксирована, блок согласующих пуст.",
                locations=[loc(text, "Часть A › Ревью требований", "Документ (версия/дата) в источнике не заполнен.")],
                suggestion="Добавить версию, дату и согласующих."),
    ]

    # поля схемы 1.2 (методика bbc-agent): тип дефекта, кто нашёл, привязка цитат
    extra = {
        "D-001": (DefectType.CONTRADICTORY, ["reviewer:consistency", "reviewer:qa"]),
        "D-002": (DefectType.CONTRADICTORY, ["reviewer:consistency"]),
        "D-003": (DefectType.AMBIGUOUS, ["inspector"]),
        "D-004": (DefectType.CONTRADICTORY, ["reviewer:contract", "reviewer:architect"]),
        "D-005": (DefectType.INCORRECT, ["inspector", "reviewer:architect", "reviewer:security"]),
        "D-006": (DefectType.UNVERIFIABLE, ["inspector"]),
        "D-007": (DefectType.NONCONFORMING, ["reviewer:analyst"]),
    }
    for f in findings:
        f.defect_type, f.found_by = extra[f.id]
        f.grounding = Grounding.EXACT
        f.verifier_note = "Подтверждено цитатами документа."

    by_req: dict[str, dict[Criterion, list[str]]] = {}
    for f in findings:
        for rid in f.requirement_ids:
            by_req.setdefault(rid, {}).setdefault(f.criterion, []).append(f.id)

    assessments = [
        RequirementAssessment(
            requirement_id=r.id,
            checks=[
                CriterionCheck(
                    criterion=c,
                    verdict=CheckVerdict.FAIL if by_req.get(r.id, {}).get(c) else CheckVerdict.PASS,
                    finding_ids=by_req.get(r.id, {}).get(c, []),
                )
                for c in REQUIREMENT_CRITERIA
            ],
        )
        for r in req
    ]
    set_fail: dict[Criterion, list[str]] = {}
    for f in findings:
        if f.scope == FindingScope.SET:
            set_fail.setdefault(f.criterion, []).append(f.id)
    set_assessment = SetAssessment(checks=[
        CriterionCheck(criterion=c, verdict=CheckVerdict.FAIL if c in set_fail else CheckVerdict.PASS,
                       finding_ids=set_fail.get(c, []),
                       assessed_by=["Контролёр логики правил", "Контролёр согласованности спецификаций"]
                       if c == Criterion.SET_CONSISTENT else [])
        for c in SET_CRITERIA
    ])

    by_sev = {s: sum(1 for f in findings if f.severity == s) for s in Severity}
    return Report(
        passport=RunPassport(
            document_name="requirements.md",
            document_sha256=hashlib.sha256(text.encode()).hexdigest(),
            run_at=datetime(2026, 11, 27, 12, 0, tzinfo=timezone.utc),
            provider="fixture", model="hand-written-sample", agent_version="fixture",
        ),
        document=ParsedDocument(name="requirements.md", format=DocumentFormat.MD,
                                sha256=hashlib.sha256(text.encode()).hexdigest(), text=text),
        requirements=req,
        requirement_assessments=assessments,
        set_assessment=set_assessment,
        findings=findings,
        checklist=[
            ChecklistItem(question="Требование может быть протестировано", answer=ChecklistAnswer.NO,
                          comment="НФТ без условий измерения, противоречивые критерии приёмки.",
                          finding_ids=["D-001", "D-006"]),
            ChecklistItem(question="Поддерживается версионность документа / зафиксирована", answer=ChecklistAnswer.NO,
                          comment="Версия и дата не заполнены.", finding_ids=["D-007"]),
        ],
        questions=[
            ClarifyingQuestion(
                id="Q-01", priority=QuestionPriority.BLOCKER, addressee="Business owner",
                question="Какая дата определяет месяц покупки для счётчика расходов: дата совершения покупки "
                "или дата её проведения?",
                why="Правило Ф-2 и критерий приёмки дают разный месяц для покупки 31 января — счётчик и push "
                "реализуют по-разному.",
                finding_ids=["D-001"], options=["Дата совершения покупки", "Дата проведения покупки"],
            ),
            ClarifyingQuestion(
                id="Q-02", priority=QuestionPriority.BLOCKER, addressee="Product owner",
                question="После смены порога в том же месяце нужно ли отправить push повторно, если новый "
                "порог достигнут?",
                why="Лимит «один push в месяц» противоречит правилу смены порога — неясно, сколько push получит клиент.",
                finding_ids=["D-002"],
                options=["Да, повторный push при новом пороге", "Нет, не больше одного push в месяц"],
            ),
        ],
        summary=Summary(requirements_total=len(req), findings_total=len(findings), by_severity=by_sev,
                        critical_finding_ids=[f.id for f in findings if f.severity == Severity.CRITICAL]),
        conclusion=Conclusion(
            ready_for_development=False, ready_for_testing=False,
            rationale="Есть противоречия между функциональными требованиями и критериями приёмки, "
            "а метод API описан некорректно.",
            top_fixes=["D-002: определить правило повторного push после смены порога",
                       "D-001: согласовать дату, определяющую месяц, с критериями приёмки",
                       "D-005: разделить чтение и сохранение порога в API"],
            decision=Decision.BLOCKED,
            development="Можно начинать Ф-1 (настройка порога); Ф-2–Ф-4 и метод API заблокированы противоречиями.",
            testing="Тест-кейсы можно писать по Ф-1; по критериям приёмки — после исправления D-001.",
            fixes=[FixItem(action="Определить правило повторного push после смены порога", why="противоречие Ф-3 и Ф-4",
                           finding_ids=["D-002"]),
                   FixItem(action="Согласовать дату, определяющую месяц, с критериями приёмки",
                           why="критерий приёмки нельзя выполнить", finding_ids=["D-001"]),
                   FixItem(action="Разделить чтение и сохранение порога в API", why="GET меняет состояние",
                           finding_ids=["D-005"])],
            strengths=["Критерии приёмки оформлены таблицей с исходными условиями и ожидаемым результатом."],
        ),
        usage=Usage(llm_calls=0),
        document_title="Уведомление о расходах по карте",
        quality=QualityStats(candidates=12, rejected_by_code=1, rejected_by_verifier=2, merged=2, confirmed=7,
                             evidence_exact=11, matrix_cells_total=54, matrix_cells_filled=54, rounds=1),
    )


def main() -> None:
    text = SAMPLE_DOC.read_text(encoding="utf-8")
    report = build(text)
    (HERE / "sample_report.json").write_text(
        report.model_dump_json(indent=2, exclude_none=False), encoding="utf-8"
    )
    (HERE / "report.schema.json").write_text(
        json.dumps(Report.model_json_schema(), ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print("written sample_report.json and report.schema.json")


if __name__ == "__main__":
    main()
