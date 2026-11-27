"""Слияние дублей и калибровка серьёзности: отчёт не должен состоять из повторов, даже если модель не ответила."""

from __future__ import annotations

import json
from types import SimpleNamespace

from req_contracts import ProviderConfig, ProviderName

from req_core import parse_document, render_report
from req_core.agent.agents import verifier as v
from req_core.agent.agents.finalizer import fix_counts
from req_core.agent.graph import Node
from req_core.agent.llm import AgentLLM, LLMTruncated
from req_core.llm import Reply
from req_core.pipeline import run_pipeline
from req_core.text import plural

from test_pipeline import scripted


def finding(fid: str, title: str, lines: list[int], *, dtype: str = "incomplete", severity: str = "major",
            level: str = "set", criterion: str = "S1", problem: str = "") -> Node:
    return Node(fid, "finding", "confirmed", {
        "title": title, "problem": problem or title, "defect_type": dtype, "severity": severity, "level": level,
        "criterion": criterion, "req_ids": [], "also": [], "source": "reviewer:qa",
        "evidence": [{"line_start": n, "line_end": n, "quote": "…"} for n in lines],
    })


def groups(nodes: list[Node]) -> list[set[str]]:
    return [set(g["ids"]) for g in v._code_groups(nodes)]


def test_code_merges_the_same_defect_reported_by_several_reviewers():
    nodes = [
        finding("C-001", "GET используется для операции изменения данных", [126]),
        finding("C-002", "GET используется для операции сохранения настроек", [126], dtype="design"),
        finding("C-003", "HTTP GET используется для операции сохранения настройки", [126, 130], dtype="incorrect"),
        # другой дефект того же места — остаётся отдельным замечанием
        finding("C-004", "Не указан срок жизни токена авторизации", [126]),
        # те же слова, но другое место документа — не дубль
        finding("C-005", "GET используется для операции изменения данных", [300]),
    ]
    assert groups(nodes) == [{"C-001", "C-002", "C-003"}]


def test_contradiction_between_the_same_two_places_is_one_defect():
    nodes = [
        finding("C-001", "Цель обещает push «в момент», НФТ допускает минуту", [22, 61], dtype="contradictory"),
        finding("C-002", "Противоречие по сроку уведомления", [22, 61], dtype="contradictory"),
        finding("C-003", "Точка отсчёта минуты не определена", [22, 61]),  # не противоречие и другие слова
    ]
    assert groups(nodes) == [{"C-001", "C-002"}]


def test_different_defects_of_one_place_are_not_merged():
    nodes = [
        finding("C-001", "Статус 201 упомянут, но не описан в разделе статусов", [180]),
        finding("C-002", "Статус 200 объявлен успешным, но пример содержит ERROR", [180], dtype="contradictory"),
    ]
    assert groups(nodes) == []


def test_merged_severity_is_the_median_of_verifier_votes():
    def settle(votes: list[str]) -> str:
        n = finding("C-001", "x", [1], severity=votes[0])
        n.payload["severity_votes"] = votes
        v._settle_severity([n])
        return n.payload["severity"]

    assert settle(["critical", "major", "major", "major", "major", "major"]) == "major"  # один голос не делает critical
    assert settle(["critical", "critical", "major"]) == "critical"
    assert settle(["critical", "major"]) == "critical"  # при равенстве — строже
    assert settle(["major", "minor", "minor"]) == "minor"


def test_set_level_criterion_follows_the_defect_type():
    ctx = SimpleNamespace(graph=SimpleNamespace(log=lambda rec: None))
    a = finding("C-001", "Правило и критерий расходятся", [1, 2], dtype="contradictory", criterion="S1")
    b = finding("C-002", "Нет эндпоинта чтения", [3], dtype="incomplete", criterion="S2")
    c = finding("C-003", "Нет критериев приёмки", [4], dtype="incomplete", criterion="S5")
    d = finding("C-004", "Противоречие внутри требования", [5], dtype="contradictory", criterion="I8", level="req")
    v._normalize_criteria(ctx, [a, b, c, d])
    assert [n.payload["criterion"] for n in (a, b, c, d)] == ["S2", "S1", "S5", "I8"]


class ThinkingClient:
    """Модель с рассуждениями: при малом лимите ответа тратит его целиком на рассуждения и не доходит до ответа."""

    def __init__(self, need: int):
        self.cfg = ProviderConfig(provider=ProviderName.OPENAI_COMPATIBLE, model="m", base_url="http://llm/v1")
        self.model = "m"
        self.usage = SimpleNamespace(prompt_tokens=0, completion_tokens=0)
        self.context_window = 200_000
        self.need = need
        self.limits: list[int] = []

    def max_tokens(self) -> int:
        return 32_768

    def complete_reply(self, system, user, limit, *, name=None):
        self.limits.append(limit)
        if limit < self.need:
            return Reply("<think>долго рассуждаю", truncated=True)
        return Reply(json.dumps({"groups": [{"ids": ["C-001", "C-002"], "reason": "один дефект"}]}))


def test_empty_truncated_reply_is_retried_with_a_roomy_limit():
    client = ThinkingClient(need=10_000)
    data = AgentLLM(client).json("verifier", "s", "u", max_tokens=6000, grow=False)
    assert data["groups"][0]["ids"] == ["C-001", "C-002"]
    assert client.limits[0] == 6000 and client.limits[1] >= 24_000 and len(client.limits) == 2


def test_truncated_reply_with_text_is_not_retried():
    class Looping(ThinkingClient):
        def complete_reply(self, system, user, limit, *, name=None):
            self.limits.append(limit)
            return Reply('{"groups": [{"ids": ["C-001", "C-002"], "reason": "x"}, {"ids": ["C-0', truncated=True)

    client = Looping(need=0)
    try:
        AgentLLM(client).json("verifier", "s", "u", max_tokens=6000, grow=False)
    except LLMTruncated as e:
        assert "C-001" in e.text
    else:
        raise AssertionError("ожидался LLMTruncated")
    assert client.limits == [6000]  # жёсткий лимит против зацикливания сохранён


def test_report_has_no_duplicates_when_the_dedup_model_fails(sample_path):
    # модель на этапе слияния дублей не отвечает JSON — явные повторы всё равно слиты кодом
    report = run_pipeline(parse_document(sample_path), scripted(dedup="не JSON"))
    contra = [f for f in report.findings if f.defect_type and f.defect_type.value == "contradictory"]
    assert len(contra) == 1 and set(contra[0].found_by) == {"reviewer:consistency", "reviewer:qa"}
    assert report.quality.merged == 1
    assert any("слияние дублей" in w for w in report.quality.warnings)
    assert "слияние дублей" in report.conclusion.rationale and "неполным" not in report.conclusion.rationale


def test_counts_in_the_verdict_text_are_checked_against_statistics():
    st = {"questions_blocking": 9, "questions_total": 15, "requirements": 51, "by_severity": {"critical": 11}}
    assert fix_counts("15 блокирующих вопросов не получили ответов.", st) == "9 блокирующих вопросов не получили ответов."
    assert fix_counts("Документ содержит 17 критических замечаний.", st) == "Документ содержит 11 критических замечаний."
    # частичный счёт (меньше итога) не трогаем
    assert fix_counts("Ещё 6 критических дефектов — неполнота, 3 блокирующих вопроса к архитектору.", st) == \
        "Ещё 6 критических дефектов — неполнота, 3 блокирующих вопроса к архитектору."
    assert fix_counts("33 из 51 требования содержат дефекты.", st) == "33 из 51 требования содержат дефекты."


def test_plural():
    assert [plural(n, "замечание", "замечания", "замечаний") for n in (1, 2, 5, 11, 21, 22, 112)] == [
        "1 замечание", "2 замечания", "5 замечаний", "11 замечаний", "21 замечание", "22 замечания", "112 замечаний"]


def test_report_is_compact_and_traceable(sample_path):
    report = run_pipeline(parse_document(sample_path), scripted())
    md = render_report(report, "md").decode("utf-8")
    assert "### Сводная матрица «требование × критерий»" in md
    assert "| Треб. | Необх. | Без реш. |" in md and "| Трасс. |" not in md
    # разбор требования: нарушенные критерии — таблицей, остальные — одной строкой
    assert "| Нарушенный критерий | Результат | Комментарий |" in md and "- **Соответствует:** " in md
    assert "| Критерий | Результат | Комментарий |" not in md
    # приложение с номерами строк: каждую ссылку «строка N» можно проверить
    assert "Приложение: текст документа с номерами строк" in md
    tz = next(f for f in report.findings if f.title == "Не задан часовой пояс")
    line = tz.locations[0].line_start
    assert any(row.startswith(f"| L{line} |") and "Ф-2" in row for row in md.split("\n"))
    assert "1 замечаний" not in md and "bbc-agent" not in md


def calibration_ctx(answer, nodes):
    log = []
    ctx = SimpleNamespace(
        doc=SimpleNamespace(title="Документ"), budget=SimpleNamespace(fits=lambda *a: True),
        llm=SimpleNamespace(json=lambda *a, **k: answer(nodes) if callable(answer) else answer),
        graph=SimpleNamespace(log=log.append), meta={}, say=lambda msg: None,
    )
    return ctx, log


def test_calibration_compares_findings_on_the_whole_list():
    nodes = [finding(f"C-{i:03d}", f"Замечание {i}", [i]) for i in range(1, 9)]
    nodes[0].payload["defect_type"] = "contradictory"
    levels = [{"id": "C-001", "severity": "minor", "reason": "мелочь"},   # противоречие ниже major не опускается
              {"id": "C-002", "severity": "critical", "reason": "блокирует"},
              {"id": "C-003", "severity": "minor", "reason": "оформление"},
              {"id": "C-999", "severity": "minor"},                          # неизвестное замечание игнорируется
              *[{"id": f"C-{i:03d}", "severity": "major"} for i in range(4, 9)]]
    ctx, log = calibration_ctx({"levels": levels}, nodes)
    v._calibrate(ctx, nodes)
    assert [n.payload["severity"] for n in nodes[:3]] == ["major", "critical", "minor"]
    assert ctx.meta["calibrated"] == 2
    assert [r["finding"] for r in log if r["kind"] == "severity_calibrated"] == ["C-002", "C-003"]


def test_calibration_is_ignored_when_the_model_rated_too_few_or_failed():
    nodes = [finding(f"C-{i:03d}", f"Замечание {i}", [i]) for i in range(1, 9)]
    ctx, log = calibration_ctx({"levels": [{"id": "C-001", "severity": "minor"}]}, nodes)
    v._calibrate(ctx, nodes)
    assert all(n.payload["severity"] == "major" for n in nodes) and log[-1]["kind"] == "calibration_failed"

    def boom(_nodes):
        raise RuntimeError("модель недоступна")

    ctx, log = calibration_ctx(boom, nodes)
    v._calibrate(ctx, nodes)
    assert all(n.payload["severity"] == "major" for n in nodes) and log[-1]["kind"] == "calibration_failed"


def test_nfr_is_written_in_russian_unless_the_document_uses_it(sample_path):
    from req_core.agent.run import russian_terms

    report = run_pipeline(parse_document(sample_path), scripted())
    report.findings[0].title = "NFR «в течение минуты» не имеет измеримого показателя"
    assert russian_terms(report).findings[0].title.startswith("НФТ «в течение минуты»")
