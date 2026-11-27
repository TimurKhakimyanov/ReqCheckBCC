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


CONTRADICTION = {
    "requirement_ids": [], "criterion": "set_consistent", "severity": "critical",
    "title": "Критерий приёмки противоречит Ф-2",
    "explanation": "Покупка 31 января попадает в февраль, хотя месяц — по дате совершения.",
    "quotes": ["Месяц определяется по дате совершения покупки в Алматы.", "Февральский счётчик вырос на 4 000 ₸"],
    "suggestion": "Согласовать правило и критерий.",
    "question": "Какая дата определяет месяц покупки: дата совершения или дата проведения?",
    "addressee": "Business owner",
}


def role_review(system, user):
    """Рецензенты набора различаются по роли в промпте."""
    if "зона — бизнес-правила" in user:  # контролёр логики правил
        return {"analysis": "Пересчитал критерий 31 января — расходится.", "issues": [CONTRADICTION],
                "checks": [{"criterion": "set_consistent", "verdict": "fail", "comment": "Есть противоречие."}]}
    if "— системный аналитик в команде" in user:
        return {"checks": [{"criterion": "set_ranked", "verdict": "fail", "comment": "Приоритеты не указаны."}]}
    if "— архитектор интеграций в команде" in user:
        return {"checks": [{"criterion": "set_feasible", "verdict": "pass", "comment": "Реализуемо."},
                           # чужой критерий рецензента не учитывается
                           {"criterion": "set_ranked", "verdict": "pass", "comment": "не моё"}]}
    return {}


def scripted():
    return FakeLLM({
        "SegmentationResult": segmentation,
        "RequirementBatchResult": requirement_batch,
        "RoleReviewResult": role_review,
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
    assert sets[Criterion.SET_FEASIBLE].comment == "Архитектор интеграций: Реализуемо."
    assert sets[Criterion.SET_RANKED].comment.startswith("Системный аналитик")
    # шесть рецензентов набора с разными ролями
    assert sum(c["schema"] == "RoleReviewResult" for c in llm.calls) == 6
    # вопрос рецензента стал уточняющим вопросом автору (модель вопросов не ответила — запасной путь)
    q = report.questions[0]
    assert q.id == "Q-01" and "дата совершения" in q.question and q.priority.value == "blocker"
    assert q.finding_ids == [contra.id] and q.addressee == "Business owner"

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


def _candidates(user):
    """Замечания в промпте верификатора: строка «C-001 | уровень: …», следующая строка — заголовок."""
    out = {}
    lines = user.split("\n")
    for i, line in enumerate(lines):
        m = re.match(r"^(C-\d{3}) \| уровень", line)
        if m and i + 1 < len(lines):
            out[m.group(1)] = lines[i + 1]
    return out


def _dedup_rows(user):
    """Строки слияния дублей: «C-001 | уровень | критерий | критичность | требования | заголовок. объяснение»."""
    rows = {}
    for line in user.split("\n"):
        m = re.match(r"^(C-\d{3}) \| ", line)
        if m:
            rows[line.split(" | ", 5)[5].split(". ", 1)[0]] = m.group(1)
    return rows


def test_verifier_drops_and_regrades(sample_path):
    def verifier(system, user):
        decisions = []
        for cid, title in _candidates(user).items():
            if "Не задан часовой пояс" in title:
                decisions.append({"finding_id": cid, "verdict": "drop", "reason": "Часовой пояс задан."})
            elif "противоречит Ф-2" in title:
                decisions.append({"finding_id": cid, "verdict": "keep", "severity": "major"})
            elif "тестировщиками" in title:  # замечания правил верификатор не отклоняет
                decisions.append({"finding_id": cid, "verdict": "drop", "severity": "minor"})
            else:
                decisions.append({"finding_id": cid, "verdict": "keep"})
        return {"decisions": decisions}

    llm = scripted()
    llm.responses["VerifierResult"] = verifier
    report = run_pipeline(parse_document(sample_path), llm, options=ValidationOptions(verify_pass=True))
    titles = {f.title: f for f in report.findings}
    assert "Не задан часовой пояс" not in titles
    assert titles["Критерий приёмки противоречит Ф-2"].severity == Severity.MAJOR
    rule = next(f for f in report.findings if "тестировщиками" in f.title)
    assert rule.source == FindingSource.RULE and rule.severity == Severity.MINOR


def test_verifier_is_on_by_default_and_skippable(sample_path):
    llm = scripted()
    run_pipeline(parse_document(sample_path), llm)
    assert any(c["schema"] == "VerifierResult" for c in llm.calls)
    llm = scripted()
    run_pipeline(parse_document(sample_path), llm, options=ValidationOptions(verify_pass=False))
    assert not any(c["schema"] in ("VerifierResult", "DedupResult") for c in llm.calls)


def test_dedup_merges_only_related_duplicates(sample_path):
    """Модель предлагает группы дублей; код сливает только замечания об одном месте или требовании."""
    twin = dict(CONTRADICTION, title="Дубль: месяц покупки противоречит критерию", severity="major", question="")

    def review(system, user):
        if "зона — документы, интерфейсы" in user:  # второй контролёр нашёл то же самое
            return {"issues": [twin]}
        return role_review(system, user)

    def dedup(system, user):
        rows = _dedup_rows(user)
        contra = rows.get("Критерий приёмки противоречит Ф-2")
        dup = next((i for t, i in rows.items() if t.startswith("Дубль")), None)
        rule = next((i for t, i in rows.items() if "тестировщиками" in t), None)
        if not (contra and dup and rule):  # второй проход (одно место документа) — без групп
            return {}
        # вторая группа ложная: замечание правила о другом месте документа — код её не сольёт
        return {"groups": [{"ids": [dup, contra], "reason": "одно и то же"}, {"ids": [contra, rule], "reason": "?"}]}

    llm = scripted()
    llm.responses["RoleReviewResult"] = review
    llm.responses["DedupResult"] = dedup
    report = run_pipeline(parse_document(sample_path), llm)
    titles = [f.title for f in report.findings]
    assert "Критерий приёмки противоречит Ф-2" in titles
    assert not any(t.startswith("Дубль") for t in titles)
    assert any("тестировщиками" in t for t in titles)
    kept = next(f for f in report.findings if f.title == "Критерий приёмки противоречит Ф-2")
    assert kept.severity == Severity.CRITICAL


def test_questions_from_model_are_numbered_and_limited(sample_path):
    def questions(system, user):
        fid = re.search(r"^(D-\d{3}) \| critical", user, re.M).group(1)
        return {"questions": [
            {"question": "Минор?", "why": "x", "priority": "minor", "finding_ids": [fid]},
            {"question": "Какая дата определяет месяц?", "why": "Блокирует счётчик.", "addressee": "Business owner",
             "priority": "blocker", "finding_ids": [fid, "D-999"], "options": ["дата совершения", "дата проведения"]},
            {"question": "Какая дата определяет месяц?", "priority": "blocker"},  # повтор отбрасывается
        ]}

    llm = scripted()
    llm.responses["QuestionsResult"] = questions
    report = run_pipeline(parse_document(sample_path), llm, options=ValidationOptions(max_questions=5))
    assert [q.id for q in report.questions] == ["Q-01", "Q-02"]
    first = report.questions[0]
    assert first.priority.value == "blocker" and first.options == ["дата совершения", "дата проведения"]
    assert "D-999" not in first.finding_ids and first.finding_ids
    md = render_report(report, "md").decode("utf-8")
    assert "Уточняющие вопросы автору документа" in md and "Q-01" in md and "(а) дата совершения" in md

    llm = scripted()
    report = run_pipeline(parse_document(sample_path), llm, options=ValidationOptions(ask_questions=False))
    assert report.questions == [] and not any(c["schema"] == "QuestionsResult" for c in llm.calls)


def test_long_model_title_is_split_without_losing_text():
    from req_core.pipeline import TITLE_LIMIT, split_title

    long = ("«Проведённые покупки» — неопределённый статус: не сказано, что считать проведённой покупкой "
            "(авторизованная, поставленная в оборот, со статусом posted), поэтому тестировщик не знает, что проверять.")
    title, expl = split_title(long, "Короткое пояснение.")
    assert len(title) <= TITLE_LIMIT and title.startswith("«Проведённые покупки» — неопределённый статус: не сказано") and title.endswith("…")
    assert long in expl and expl.endswith("Короткое пояснение.")
    assert split_title("Коротко", "Пояснение") == ("Коротко", "Пояснение")
    assert split_title("", "Только пояснение") == ("Только пояснение", "Только пояснение")


def test_checklist_prompt_sees_the_document(sample_path):
    llm = FakeLLM()
    run_pipeline(parse_document(sample_path), llm)
    call = next(c for c in llm.calls if c.get("schema") == "ChecklistResult")
    assert "<document>" in call["user"] and "Архитектура решения" in call["user"]


def test_short_first_phrase_is_not_used_as_title():
    from req_core.pipeline import TITLE_LIMIT, split_title

    long = "«Переводы» — не определено, относятся ли к ним переводы между своими картами, пополнения и платежи по реквизитам"
    title, _ = split_title(long, "")
    assert title.startswith("«Переводы» — не определено") and len(title) <= TITLE_LIMIT


def test_foreign_script_leaks_are_removed_from_model_text(sample_path):
    llm = scripted()
    llm.responses["ConclusionResult"] = {"rationale": "Нет ветки除了happy-path.", "top_fixes": ["Описать ветки除了успеха"]}
    report = run_pipeline(parse_document(sample_path), llm)
    assert report.conclusion.rationale == "Нет ветки happy-path."
    assert report.conclusion.top_fixes == ["Описать ветки успеха"]


def test_title_is_not_cut_at_status_code_period():
    from req_core.pipeline import split_title

    long = ("Требование 401 размещено в разделе «200. Successful — Created», что противоречит смыслу кода 401 "
            "и вводит в заблуждение разработчика и тестировщика при реализации обработки ошибок авторизации")
    title, _ = split_title(long, "")
    assert "Successful" in title
