import re

from req_contracts import (
    REQUIREMENT_CRITERIA,
    SET_CRITERIA,
    CheckVerdict,
    Criterion,
    FindingSource,
    RequirementKind,
    RunStage,
    Severity,
    ValidationOptions,
)

from req_core import parse_document, render_report
from req_core.pipeline import run_pipeline
from req_core.testing import FakeLLM

F2 = ("Месяц определяется по дате совершения покупки в Алматы. В расходы входят проведённые покупки. "
      "Возврат уменьшает расходы месяца исходной покупки. Переводы и снятие наличных исключаются.")


def segmentation(system, user):
    return {"requirements": [
        {"source_id": "Ф-2", "kind": "functional", "quote": F2, "summary": "Правила учёта расходов месяца",
         "parts": [
             {"quote": "Месяц определяется по дате совершения покупки в Алматы.", "summary": "Месяц по дате покупки"},
             {"quote": "Возврат уменьшает расходы месяца исходной покупки.", "summary": "Учёт возвратов"},
         ]},
        {"source_id": "", "kind": "functional", "quote": "Требование, которого нет в документе ни в каком виде",
         "summary": "фантом"},
    ]}


def requirement_batch(system, user):
    m = re.search(r"### (R-\d{3}) · в документе: Ф-2", user)
    if not m:
        return {}
    rid = m.group(1)
    return {
        "issues": [
            {"requirement_ids": [rid + ".1"], "criterion": "unambiguous", "severity": "major",
             "title": "Не задан часовой пояс", "explanation": "«В Алматы» не задаёт смещение UTC.",
             "quotes": ["по дате совершения покупки в Алматы"], "suggestion": "Указать UTC+5."},
            {"requirement_ids": [rid], "criterion": "complete", "severity": "major",
             "title": "Не описан возврат после отправки push", "explanation": "Неясно, что с push.",
             "quotes": ["Цитата, которую модель выдумала и которой нет в тексте"], "suggestion": ""},
            {"requirement_ids": [], "criterion": "verifiable", "severity": "minor",
             "title": "Фантомный дефект", "explanation": "x",
             "quotes": ["Ещё одна выдуманная цитата без привязки к требованию"]},
        ],
        "not_applicable": [{"requirement_id": rid, "not_applicable": ["implementation_free"]}],
    }


def consistency(system, user):
    return {"issues": [{
        "requirement_ids": [], "criterion": "set_consistent", "severity": "critical",
        "title": "Критерий приёмки противоречит Ф-2",
        "explanation": "Покупка 31 января попадает в февраль, хотя месяц — по дате совершения.",
        "quotes": ["Месяц определяется по дате совершения покупки в Алматы.", "Февральский счётчик вырос на 4 000 ₸"],
        "suggestion": "Согласовать правило и критерий."}]}


def review(system, user):
    return {"issues": [], "checks": [
        {"criterion": "set_ranked", "verdict": "fail", "comment": "Приоритеты не указаны."},
        {"criterion": "set_feasible", "verdict": "pass", "comment": "Реализуемо."},
    ]}


def scripted():
    return FakeLLM({
        "SegmentationResult": segmentation,
        "RequirementBatchResult": requirement_batch,
        "SetConsistencyResult": consistency,
        "SetReviewResult": review,
        "ConclusionResult": {"rationale": "Есть критичное противоречие D-xxx.", "top_fixes": ["Исправить Ф-2"]},
    })


def test_pipeline_with_scripted_llm(sample_path):
    doc = parse_document(sample_path)
    llm = scripted()
    events = []
    report = run_pipeline(doc, llm, options=ValidationOptions(knowledge_snippets=["Глоссарий: тиын = 1/100 тенге"]),
                          on_progress=events.append, provider="fake", model="fake-model")
    text = report.document.text

    # нарезка: Ф-2 разбит на части, фантом отброшен, подсказки правил добавлены
    ids = {r.id: r for r in report.requirements}
    f2 = next(r for r in report.requirements if r.source_id == "Ф-2")
    assert f2.summary == "Правила учёта расходов месяца"
    kids = [r for r in report.requirements if r.parent_id == f2.id]
    assert [k.id for k in kids] == [f2.id + ".1", f2.id + ".2"]
    assert not any("фантом" in r.summary for r in report.requirements)
    assert sum(r.kind == RequirementKind.ACCEPTANCE for r in report.requirements) == 3
    assert [r.id for r in report.requirements if not r.parent_id][:2] == ["R-001", "R-002"]

    # все подтверждённые цитаты совпадают с текстом по смещениям
    locs = [r.location for r in report.requirements] + [l for f in report.findings for l in f.locations]
    for loc in locs:
        if loc.verified:
            assert text[loc.char_start:loc.char_end] == loc.quote
    assert all(r.location.verified for r in report.requirements)

    titles = {f.title: f for f in report.findings}
    assert "Фантомный дефект" not in titles  # нет цитаты и нет требования — отброшен
    tz = titles["Не задан часовой пояс"]
    assert tz.requirement_ids == [f2.id + ".1"] and tz.locations[0].verified
    reanchored = titles["Не описан возврат после отправки push"]
    assert reanchored.locations[0].verified and reanchored.locations[0].quote == f2.location.quote
    assert any(not loc.verified for loc in reanchored.locations)
    contra = titles["Критерий приёмки противоречит Ф-2"]
    assert contra.severity == Severity.CRITICAL and len(contra.locations) == 2
    assert contra.id in report.summary.critical_finding_ids
    assert any(f.source == FindingSource.RULE and "тестировщиками" in f.title for f in report.findings)
    assert any(f.criterion == Criterion.SINGULAR and f2.id in f.requirement_ids for f in report.findings)

    # оценки
    assert len(report.requirement_assessments) == len(report.requirements)
    a = next(x for x in report.requirement_assessments if x.requirement_id == f2.id)
    assert [c.criterion for c in a.checks] == REQUIREMENT_CRITERIA
    by_c = {c.criterion: c for c in a.checks}
    assert by_c[Criterion.COMPLETE].verdict == CheckVerdict.FAIL
    assert by_c[Criterion.IMPLEMENTATION_FREE].verdict == CheckVerdict.NOT_APPLICABLE
    sets = {c.criterion: c for c in report.set_assessment.checks}
    assert [c.criterion for c in report.set_assessment.checks] == SET_CRITERIA
    assert sets[Criterion.SET_CONSISTENT].verdict == CheckVerdict.FAIL
    assert sets[Criterion.SET_RANKED].verdict == CheckVerdict.FAIL
    assert sets[Criterion.SET_FEASIBLE].comment == "Реализуемо."

    # сводка, итог, чек-лист, id
    assert report.summary.findings_total == len(report.findings)
    assert report.summary.requirements_total == len(report.requirements)
    assert [f.id for f in report.findings] == [f"D-{i:03d}" for i in range(1, len(report.findings) + 1)]
    known = {f.id for f in report.findings}
    for x in report.requirement_assessments:
        for c in x.checks:
            assert set(c.finding_ids) <= known
    assert report.conclusion.ready_for_development is False
    assert report.conclusion.top_fixes == ["Исправить Ф-2"]
    assert len(report.checklist) == 14
    assert report.usage.llm_calls == len([c for c in llm.calls if c["kind"] == "json"])
    assert report.passport.provider == "fake" and report.passport.model == "fake-model"

    # прогресс монотонный и заканчивается DONE; база знаний попала в промпт
    assert events[-1].stage == RunStage.DONE and events[-1].progress == 1.0
    assert all(a.progress <= b.progress for a, b in zip(events, events[1:]))
    assert all("тиын = 1/100 тенге" in c["system"] for c in llm.calls if c["kind"] == "json")
    # эталон из samples не попадает в промпты
    assert not any("reference" in c["user"].lower() for c in llm.calls if c["kind"] == "json")

    md = render_report(report, "md").decode("utf-8")
    for f in report.findings:
        assert f.id in md
    assert f2.id + ".1" in md and ids


def test_pipeline_without_llm_answers_uses_rules(sample_path):
    report = run_pipeline(parse_document(sample_path), FakeLLM(), provider="fake", model="fake")
    assert report.summary.requirements_total >= 10
    assert report.findings, "детерминированные проверки должны найти дефекты"
    assert all(f.source == FindingSource.RULE for f in report.findings)
    assert report.conclusion.rationale
    assert report.conclusion.ready_for_development is True  # без LLM критичных нет


def test_no_split_option(sample_path):
    report = run_pipeline(parse_document(sample_path), scripted(),
                          options=ValidationOptions(split_compound=False, fill_checklist=False))
    assert not any(r.parent_id for r in report.requirements)
    assert report.checklist == []


def test_verify_pass_drops_and_regrades(sample_path):
    def critic(system, user):
        ids = re.findall(r"^(tmp-\d+) \[", user, re.M)
        lines = {i: user[user.index(i):].split("\n", 1)[0] for i in ids}
        verdicts = []
        for i, line in lines.items():
            if "Не задан часовой пояс" in line:
                verdicts.append({"finding_id": i, "keep": False, "reason": "дубль"})
            if "противоречит Ф-2" in line:
                verdicts.append({"finding_id": i, "keep": True, "severity": "major"})
        return {"verdicts": verdicts}

    llm = scripted()
    llm.responses["CriticResult"] = critic
    report = run_pipeline(parse_document(sample_path), llm, options=ValidationOptions(verify_pass=True))
    titles = {f.title: f for f in report.findings}
    assert "Не задан часовой пояс" not in titles
    assert titles["Критерий приёмки противоречит Ф-2"].severity == Severity.MAJOR


def test_long_model_title_is_split_without_losing_text():
    from req_core.pipeline import TITLE_LIMIT, split_title

    long = ("«Проведённые покупки» — неопределённый статус: не сказано, что считать проведённой покупкой "
            "(авторизованная, поставленная в оборот, со статусом posted), поэтому тестировщик не знает, что проверять.")
    title, expl = split_title(long, "Короткое пояснение.")
    assert len(title) <= TITLE_LIMIT and title.startswith("«Проведённые покупки»")
    assert long in expl and expl.endswith("Короткое пояснение.")
    assert split_title("Коротко", "Пояснение") == ("Коротко", "Пояснение")
    assert split_title("", "Только пояснение") == ("Только пояснение", "Только пояснение")


def test_checklist_prompt_sees_the_document(sample_path):
    llm = FakeLLM()
    run_pipeline(parse_document(sample_path), llm)
    call = next(c for c in llm.calls if c.get("schema") == "ChecklistResult")
    assert "<document>" in call["user"] and "Архитектура решения" in call["user"]
