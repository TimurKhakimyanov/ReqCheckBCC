"""Конвейер агентов bbc-agent (req_core.agent) на FakeLLM: сценарии ответов по именам промтов."""

import json
import re

from req_contracts import (
    REQUIREMENT_CRITERIA,
    SET_CRITERIA,
    CheckVerdict,
    ChecklistAnswer,
    Criterion,
    Decision,
    DefectType,
    Grounding,
    QuestionPriority,
    RequirementKind,
    RunStage,
    Severity,
    ValidationOptions,
)

from req_core import parse_document, render_report
from req_core.pipeline import TITLE_LIMIT, run_pipeline, split_title
from req_core.testing import FakeLLM


def _line(user: str, needle: str) -> int:
    """Номер строки L<n>| документа в промте, содержащей needle."""
    for m in re.finditer(r"^L(\d+)\| (.*)$", user, re.M):
        if needle in m.group(2):
            return int(m.group(1))
    raise AssertionError(f"нет строки с «{needle}» в промте")


def extractor(system, user):
    out = []
    for fid, summary in (("Ф-1", "Порог расходов"), ("Ф-2", "Правила учёта расходов месяца"),
                         ("Ф-3", "Push при достижении порога"), ("Ф-4", "Смена порога")):
        n = _line(user, f"**{fid}.**")
        out.append({"doc_id": fid, "line_start": n, "line_end": n, "quote": "", "summary": summary,
                    "type": "functional"})
    n = _line(user, "Сервис передаёт push на отправку")
    out.append({"doc_id": None, "line_start": n, "line_end": n,
                "quote": "Сервис передаёт push на отправку в течение минуты после получения события.",
                "summary": "Push в течение минуты", "type": "non_functional"})
    n = _line(user, "Покупка 31 января")
    out.append({"doc_id": None, "line_start": n, "line_end": n, "quote": "Покупка 31 января в 23:58 на 4 000 ₸",
                "summary": "Критерий: покупка на границе месяца", "type": "acceptance"})
    # требование, которого нет в документе: ни строки, ни цитаты — отбрасывается кодом
    out.append({"doc_id": None, "line_start": 99999, "line_end": 99999, "quote": "Фантом, которого нет в тексте",
                "summary": "фантом", "type": "functional"})
    return {"requirements": out}


def inspector(system, user):
    block = user.split("Требования для проверки:\n", 1)[1].split("\n\nПодсказки автоматических правил:", 1)[0]
    reqs = json.loads(block)
    results = []
    for r in reqs:
        verdicts = {f"I{i}": "ok" for i in range(1, 10)}
        findings = []
        if r["doc_id"] == "Ф-2":
            verdicts["I3"] = "violation"
            findings.append({"criterion": "I3", "severity": "major", "defect_type": "ambiguous",
                             "title": "Не задан часовой пояс",
                             "quote": "по дате совершения покупки в Алматы",
                             "problem": "«В Алматы» не задаёт смещение UTC: покупка в 23:58 может попасть в разные месяцы.",
                             "recommendation": "Указать UTC+5.", "question": None, "addressee": None})
            verdicts["I4"] = "violation"  # подтверждено замечанием, которое отбросит контроль достоверности
            findings.append({"criterion": "I4", "severity": "major", "defect_type": "incomplete",
                             "title": "Выдумка", "quote": "Цитата, которой нет в тексте документа совсем",
                             "problem": "Модель утверждает «здесь написано то, чего в документе нет вообще никогда».",
                             "recommendation": ""})
        if r["doc_id"] == "Ф-1":
            verdicts["I9"] = "na"
        results.append({"id": r["id"], "analysis": "…", "verdicts": verdicts, "findings": findings})
    return {"results": results}


CONTRA = {"criterion": "S2", "severity": "major", "defect_type": "contradictory",
          "title": "Критерий приёмки противоречит Ф-2",
          "problem": "Покупка 31 января попадает в февральский счётчик, хотя месяц определяется по дате совершения.",
          "recommendation": "Согласовать правило и критерий.",
          "question": "Какая дата определяет месяц покупки: совершения или проведения?",
          "addressee": "Business owner"}


def reviewer(system, user):
    if "зона — бизнес-правила" in system:  # контролёр логики правил
        ev = [{"line": _line(user, "**Ф-2.**"), "quote": "Месяц определяется по дате совершения покупки в Алматы."},
              {"line": _line(user, "Покупка 31 января"), "quote": "Февральский счётчик вырос на 4 000 ₸"}]
        return {"analysis": "Пересчитал критерий 31 января — расходится.",
                "verdicts": {"S2": {"status": "violation", "rationale": "Критерий приёмки расходится с Ф-2."}},
                "findings": [{**CONTRA, "evidence": ev, "req_ids": ["R-002"]}]}
    if "«Тест-аналитик»" in system:  # тот же дефект другими словами — дубль
        ev = [{"line": _line(user, "Покупка 31 января"), "quote": "Февральский счётчик вырос на 4 000 ₸"}]
        return {"verdicts": {"S5": {"status": "ok", "rationale": "Критерии приёмки есть."}},
                "findings": [{**CONTRA, "criterion": "S5", "title": "Ожидаемый результат критерия неверен",
                              "evidence": ev}]}
    if "«Системный аналитик»" in system:
        ev = [{"line": _line(user, "**Ф-1.**"), "quote": "Держатель активной карты KZT задаёт целый порог"}]
        return {"verdicts": {"S6": {"status": "violation", "rationale": "Приоритеты не указаны."}},
                "findings": [{"criterion": "S6", "severity": "minor", "defect_type": "nonconforming",
                              "title": "Приоритеты не указаны",
                              "problem": "У требований нет приоритета, непонятно, что обязательно для первой поставки.",
                              "evidence": ev}]}
    return {}


def verifier(system, user):
    out = []
    for cid, title in re.findall(r"^(C-\d{3}) \|[^\n]*\n\s*Суть: ([^.\n]*)", user, re.M):
        if "Приоритеты" in title:
            out.append({"id": cid, "verdict": "drop", "severity": "minor", "reason": "Приоритеты указаны в разделе 3."})
        elif "противоречит" in title:
            out.append({"id": cid, "verdict": "keep", "severity": "critical", "reason": "Подтверждено обеими цитатами."})
        else:
            out.append({"id": cid, "verdict": "keep", "severity": "major", "reason": "Подтверждено."})
    return {"decisions": out}


def dedup(system, user):
    ids = [cid for cid, rest in re.findall(r"^(C-\d{3}) \|(.*)$", user, re.M)
           if "противоречит" in rest or "Ожидаемый результат" in rest]
    return {"groups": [{"ids": ids, "reason": "один дефект"}]} if len(ids) > 1 else {}


def clarifier(system, user):
    fid = re.search(r"^(D-\d{3}) \| уровень: набор", user, re.M).group(1)
    return {"questions": [
        {"question": "Какая дата определяет месяц покупки: дата совершения или дата проведения (см. R-999)?",
         "why": "Без ответа счётчик и критерий приёмки реализуют по-разному.", "addressee": "Business owner",
         "priority": "blocker", "finding_ids": [fid, "D-777"], "options": ["Дата совершения", "Дата проведения"]},
        {"question": "Нужен ли повторный push после возврата?", "why": "Неясно поведение.", "priority": "minor",
         "finding_ids": [], "options": []},
    ]}


def checklist(system, user):
    rows = [int(n) for n in re.findall(r"^L(\d+) \|", user, re.M)]
    return {"rows": [{"line": rows[0], "answer": "Частично", "comment": "Есть противоречие D-001."},
                     {"line": rows[1], "answer": "Да", "comment": "Структура по шаблону."}]}


def verdict(system, user):
    return {"decision": "можно", "development": "Можно брать Ф-1, Ф-3.", "testing": "Тест-кейсы по Ф-1.",
            "rationale": "Есть противоречие в ключевой логике.",
            "top_fixes": [{"action": "Согласовать правило месяца и критерий приёмки", "why": "блокирует счётчик",
                           "finding_ids": ["D-001", "D-999"]}],
            "strengths": ["Критерии приёмки оформлены таблицей."]}


def scripted(**extra):
    return FakeLLM({"extractor": extractor, "inspector": inspector, "reviewer": reviewer, "verifier": verifier,
                    "dedup": dedup, "clarifier": clarifier, "checklist": checklist, "verdict": verdict, **extra})


def test_pipeline_with_scripted_llm(sample_path):
    events = []
    llm = scripted()
    report = run_pipeline(parse_document(sample_path), llm, on_progress=events.append)

    # нарезка: требования модели + кандидаты правил; фантом отброшен
    by_src = {r.source_id: r for r in report.requirements if r.source_id}
    assert {"Ф-1", "Ф-2", "Ф-3", "Ф-4"} <= set(by_src)
    assert all("Фантом" not in r.location.quote for r in report.requirements)
    for r in report.requirements:
        loc = r.location
        assert report.document.text[loc.char_start:loc.char_end] == loc.quote and loc.line_start
    assert any(r.kind == RequirementKind.ACCEPTANCE for r in report.requirements)

    # контроль достоверности: выдуманная цитата не прошла; дубль слит; верификатор отклонил и ужесточил
    titles = [f.title for f in report.findings]
    assert "Выдумка" not in titles and "Приоритеты не указаны" not in titles
    contra = [f for f in report.findings if f.defect_type == DefectType.CONTRADICTORY]
    assert len(contra) == 1
    c = contra[0]
    assert c.severity == Severity.CRITICAL and c.criterion == Criterion.SET_CONSISTENT
    assert set(c.found_by) == {"reviewer:consistency", "reviewer:qa"}
    assert len(c.locations) == 2 and all(loc.verified for loc in c.locations)
    assert c.grounding == Grounding.EXACT and c.verifier_note
    tz = next(f for f in report.findings if f.title == "Не задан часовой пояс")
    r2 = by_src["Ф-2"].id
    assert tz.requirement_ids == [r2] and tz.found_by == ["inspector"]
    assert report.document.text[tz.locations[0].char_start:tz.locations[0].char_end] == \
        "по дате совершения покупки в Алматы"
    q = report.quality
    assert q.rejected_by_code >= 1 and q.rejected_by_verifier == 1 and q.merged == 1
    assert q.matrix_cells_filled == q.matrix_cells_total > 0 and not q.uncovered_requirements

    # проверка требований: вердикты инспектора приведены к подтверждённым замечаниям
    checks = {c.criterion: c for c in next(a for a in report.requirement_assessments if a.requirement_id == r2).checks}
    assert len(checks) == len(REQUIREMENT_CRITERIA)
    assert checks[Criterion.UNAMBIGUOUS].verdict == CheckVerdict.FAIL
    assert checks[Criterion.UNAMBIGUOUS].finding_ids == [tz.id]
    assert checks[Criterion.COMPLETE].verdict == CheckVerdict.PASS  # нарушение без подтверждённого замечания
    assert checks[Criterion.TRACEABLE].verdict == CheckVerdict.NOT_APPLICABLE
    f1 = next(a for a in report.requirement_assessments if a.requirement_id == by_src["Ф-1"].id)
    assert {c.criterion: c.verdict for c in f1.checks}[Criterion.CONFORMING] == CheckVerdict.NOT_APPLICABLE

    # набор: замечания и мнения рецензентов
    sc = {c.criterion: c for c in report.set_assessment.checks}
    assert len(sc) == len(SET_CRITERIA)
    assert sc[Criterion.SET_CONSISTENT].verdict == CheckVerdict.FAIL
    assert sc[Criterion.SET_CONSISTENT].assessed_by == ["Контролёр логики правил"]
    assert sc[Criterion.SET_RANKED].verdict == CheckVerdict.PASS  # нарушение не подтверждено верификатором
    assert sc[Criterion.SET_VALIDATABLE].verdict == CheckVerdict.PASS

    # вопросы: несуществующие ссылки вычищены, сначала блокирующие
    assert [q.id for q in report.questions] == ["Q-01", "Q-02"]
    q1 = report.questions[0]
    assert q1.priority == QuestionPriority.BLOCKER and "R-999" not in q1.question
    assert q1.finding_ids == [c.id] and q1.options == ["Дата совершения", "Дата проведения"]

    # чек-лист: ответы модели, «Частично», и запасные ответы для остальных пунктов
    assert report.checklist[0].answer == ChecklistAnswer.PARTIAL
    assert report.checklist[0].finding_ids == ["D-001"] or report.checklist[0].finding_ids == []
    assert len(report.checklist) >= 10

    # итог: модель сказала «можно», но есть критичный дефект — предохранитель
    cc = report.conclusion
    assert cc.decision == Decision.LIMITED and "критичные" in cc.guard_note
    assert cc.ready_for_development and not cc.ready_for_testing
    assert cc.fixes[0].finding_ids == ["D-001"] and cc.top_fixes[0].startswith("D-001: ")
    assert cc.strengths and cc.development and cc.testing

    # прогресс: стадии по порядку, проверка набора видна отдельно
    stages = [e.stage for e in events]
    assert stages[0] == RunStage.PARSING and stages[-1] == RunStage.DONE
    assert RunStage.CHECKING_SET in stages and RunStage.CHECKING_REQUIREMENTS in stages
    assert [e.progress for e in events] == sorted(e.progress for e in events)

    md = render_report(report, "md").decode("utf-8")
    assert "Можно с ограничениями" in md and c.id in md
    assert render_report(report, "pdf")[:5] == b"%PDF-"


def test_pipeline_without_llm_answers_keeps_rule_candidates(sample_path):
    report = run_pipeline(parse_document(sample_path), FakeLLM())
    assert {"Ф-1", "Ф-2", "Ф-3", "Ф-4"} <= {r.source_id for r in report.requirements}
    assert report.findings == []  # правила — только подсказки агентам, без модели дефектов нет
    # модель не дала вердиктов — итог не «можно», в отчёте видно, что проверено не всё
    assert report.conclusion.decision == Decision.LIMITED
    assert report.quality.uncovered_requirements and "неполным" in report.conclusion.rationale


def test_rule_hints_reach_agents(sample_path):
    llm = FakeLLM()
    run_pipeline(parse_document(sample_path), llm)
    ins = next(c for c in llm.calls if c.get("prompt") == "inspector")
    rev = next(c for c in llm.calls if c.get("prompt") == "reviewer")
    # подсказки правил bbc-agent и ReqCheck (незаполненный раздел) — в промтах инспектора и рецензентов
    assert "размытая формулировка" in ins["user"] or "временное условие" in ins["user"]
    assert "заполняются тестировщиками" in rev["user"]


def test_verifier_is_on_by_default_and_skippable(sample_path):
    llm = scripted()
    run_pipeline(parse_document(sample_path), llm)
    assert any(c.get("prompt") == "verifier" for c in llm.calls)
    llm = scripted()
    report = run_pipeline(parse_document(sample_path), llm, options=ValidationOptions(verify_pass=False))
    assert not any(c.get("prompt") in ("verifier", "dedup") for c in llm.calls)
    assert "Приоритеты не указаны" in [f.title for f in report.findings]  # без оппонента замечание остаётся


def test_questions_and_checklist_can_be_switched_off(sample_path):
    llm = scripted()
    report = run_pipeline(parse_document(sample_path), llm,
                          options=ValidationOptions(ask_questions=False, fill_checklist=False))
    assert report.questions == [] and report.checklist == []
    assert not any(c.get("prompt") in ("clarifier", "checklist") for c in llm.calls)


def test_answers_produce_rewrites(sample_path):
    def resolver(system, user):
        assert "Ответ автора: Дата совершения" in user
        rid = re.search(r"требования: (R-\d{3})", user).group(1)
        fid = re.search(r"замечания: (D-\d{3})", user).group(1)
        return {"resolutions": [{"question_id": "Q-01", "rewrites": [{"req_id": rid, "new_text": "Месяц — по дате совершения (UTC+5)."}],
                                 "closes_findings": [fid], "note": "Критерий приёмки поправить."}]}

    report = run_pipeline(parse_document(sample_path), scripted(resolver=resolver),
                          options=ValidationOptions(answers={"Q-01": "Дата совершения"}))
    q1 = report.questions[0]
    assert q1.answer == "Дата совершения" and q1.resolution.rewrites[0].new_text.startswith("Месяц")
    closed = q1.resolution.closes_findings[0]
    assert next(f for f in report.findings if f.id == closed).resolved_by == "Q-01"
    md = render_report(report, "md").decode("utf-8")
    assert "Месяц — по дате совершения (UTC+5)." in md


def test_knowledge_snippets_in_system_prompt(sample_path):
    llm = FakeLLM()
    run_pipeline(parse_document(sample_path), llm, options=ValidationOptions(knowledge_snippets=["Тиын — 1/100 тенге"]))
    ins = next(c for c in llm.calls if c.get("prompt") == "inspector")
    ext = next(c for c in llm.calls if c.get("prompt") == "extractor")
    assert "Тиын — 1/100 тенге" in ins["system"] and "Тиын" not in ext["system"]


def test_parallel_workers_give_same_result(sample_path):
    one = run_pipeline(parse_document(sample_path), scripted())
    many = run_pipeline(parse_document(sample_path), scripted(), options=ValidationOptions(concurrency=4, batch_size=2))
    assert [(f.id, f.title) for f in one.findings] == [(f.id, f.title) for f in many.findings]


def test_long_model_title_is_split_without_losing_text():
    title = "Очень длинный заголовок " * 10
    short, expl = split_title(title, "Пояснение.")
    assert len(short) <= TITLE_LIMIT and " ".join(title.split()) in expl


def test_foreign_script_leaks_are_removed_from_model_text(sample_path):
    def leaky(system, user):
        out = verdict(system, user)
        out["rationale"] = "Есть противоречие 矛盾 в логике."
        return out

    report = run_pipeline(parse_document(sample_path), scripted(verdict=leaky))
    assert "矛盾" not in report.conclusion.rationale


def test_interactive_answers_like_bbc_ask(sample_path, monkeypatch, capsys):
    """CLI --ask: вопросы в консоли, ответ номером варианта учитывается в этом же прогоне."""
    seen = {}

    def resolver(system, user):
        seen["user"] = user
        return {"resolutions": []}

    replies = iter(["1", "q"])
    monkeypatch.setattr("builtins.input", lambda prompt="": next(replies))
    report = run_pipeline(parse_document(sample_path), scripted(resolver=resolver), interactive=True)
    q1 = report.questions[0]
    assert q1.answer == q1.options[0]
    assert f"Ответ автора: {q1.options[0]}" in seen["user"]
    assert "Агент задаёт уточняющие вопросы" in capsys.readouterr().out


def test_web_ask_author_pauses_on_questions_and_uses_answers(sample_path):
    """Веб-аналог --ask: при options.ask_author ядро отдаёт вопросы обработчику и учитывает ответы в этом же прогоне."""
    asked: list = []

    def ask(questions):
        asked.append(questions)
        q = questions[0]
        return {q.id: q.options[0], "Q-99": "лишний ответ на несуществующий вопрос"}

    def resolver(system, user):
        return {"resolutions": []}

    events = []
    report = run_pipeline(parse_document(sample_path), scripted(resolver=resolver), on_progress=events.append,
                          options=ValidationOptions(ask_author=True), ask_author=ask)
    assert len(asked) == 1 and asked[0] and all(q.question for q in asked[0])
    q1 = next(q for q in report.questions if q.id == asked[0][0].id)
    assert q1.answer == asked[0][0].options[0]
    assert any("Ждём ответов автора" in e.message for e in events)
    # без флага обработчик не вызывается — прогон не ждёт
    asked.clear()
    run_pipeline(parse_document(sample_path), scripted(resolver=resolver), ask_author=ask)
    assert asked == []
