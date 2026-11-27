from req_contracts import Criterion, RequirementKind

from req_core import parse_document
from req_core.rules import ReqDraft, extract_checklist, rule_findings, segment_hints
from req_core.text import SectionIndex


def _hints(text):
    return segment_hints(text, SectionIndex(text))


def test_segment_hints_on_sample(sample_path):
    text = parse_document(sample_path).text
    hints = _hints(text)
    ids = [h.source_id for h in hints if h.source_id]
    assert ids[:4] == ["Ф-1", "Ф-2", "Ф-3", "Ф-4"]
    assert {"cardId", "amount", "enabled"} <= set(ids)
    acc = [h for h in hints if h.kind == RequirementKind.ACCEPTANCE]
    assert len(acc) == 3
    assert any("Февральский счётчик" in text[h.start:h.end] for h in acc)
    f1 = next(h for h in hints if h.source_id == "Ф-1")
    assert text[f1.start:f1.end].startswith("Держатель активной карты KZT")
    assert text[f1.start:f1.end].endswith("По умолчанию уведомление выключено.")
    nfr = [h for h in hints if h.kind == RequirementKind.NON_FUNCTIONAL]
    assert any("в течение минуты" in text[h.start:h.end] for h in nfr)
    # чек-лист и блок согласующих — не требования
    assert not any("Ревью требований" in SectionIndex(text).path(h.start) for h in hints)
    # спаны не пересекаются
    spans = sorted((h.start, h.end) for h in hints)
    assert all(a[1] <= b[0] for a, b in zip(spans, spans[1:]))


def test_segment_hints_generic_ids_and_tables():
    text = (
        "## Требования\n\n"
        "1. FR-12: The system shall export reports.\n"
        "* **НФТ-3.** Время ответа не более 2 с.\n\n"
        "| ID | Требование |\n| :--- | :--- |\n| ФТ-7 | Хранить историю 5 лет |\n"
    )
    hints = _hints(text)
    assert [h.source_id for h in hints] == ["FR-12", "НФТ-3", "ФТ-7"]
    assert text[hints[2].start:hints[2].end] == "Хранить историю 5 лет"


def test_rule_findings_on_sample(sample_path):
    text = parse_document(sample_path).text
    sections = SectionIndex(text)
    drafts = _hints(text)
    for i, d in enumerate(drafts, 1):
        d.id = f"R-{i:03d}"
    found = rule_findings(text, sections, drafts)
    titles = " | ".join(f.title for f in found)
    assert "заполняются тестировщиками" in titles
    assert any(f.criterion == Criterion.SET_MODIFIABLE for f in found)
    assert any("Swagger" in f.title for f in found)
    assert any("Пустые строки" in f.title for f in found)
    assert any(f.criterion == Criterion.SET_VALIDATABLE for f in found)
    for f in found:
        assert f.spans, f.title
        for s, e in f.spans:
            assert 0 <= s < e <= len(text)


def test_vague_words_inside_requirements():
    text = "## Нефункциональные требования\n\nСистема должна быстро отвечать и т.д.\n"
    sections = SectionIndex(text)
    d = ReqDraft(text.index("Система"), len(text) - 1, RequirementKind.NON_FUNCTIONAL, "x", id="R-001")
    found = rule_findings(text, sections, [d])
    vague = [f for f in found if f.criterion == Criterion.UNAMBIGUOUS]
    assert len(vague) == 2
    assert all(f.requirement_ids == ["R-001"] for f in vague)
    assert any(text[s:e] == "быстро" for f in vague for s, e in f.spans)


def test_extract_checklist(sample_path):
    text = parse_document(sample_path).text
    items = extract_checklist(text, SectionIndex(text))
    assert len(items) == 14
    assert items[0][0].startswith("Техническое требование зафиксировано")
