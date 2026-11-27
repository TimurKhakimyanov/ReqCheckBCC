import io
import json
import re

import pytest
from req_contracts import REQUIREMENT_CRITERIA, Report

from req_core import render_report
from req_core.chat import answer_stream
from req_core.testing import FakeLLM

SECTIONS = [
    "## 1. Паспорт прогона",
    "## 2. Как агент нарезал требования",
    "## 3. Проверка каждого требования",
    "## 4. Проверка всего набора требований",
    "Сводка",
    "Итог",
]


def test_markdown_has_all_required_sections(sample_report):
    md = render_report(sample_report, "md").decode("utf-8")
    pos = [md.index(s) for s in SECTIONS]
    assert pos == sorted(pos)
    p = sample_report.passport
    for s in (p.document_name, p.model, p.agent_version, "| ID в отчёте | ID в документе |"):
        assert s in md
    for r in sample_report.requirements:
        assert f"| {r.id} |" in md
    for f in sample_report.findings:
        assert f"#### {f.id}" in md
        assert f.locations[0].section in md
    assert "Можно начинать разработку:** нет" in md


def test_markdown_escapes_pipes_in_tables(sample_report):
    md = render_report(sample_report, "md").decode("utf-8")
    for line in md.splitlines():
        if line.startswith("| R-"):
            cells = re.split(r"(?<!\\)\|", line.strip())[1:-1]
            # таблица нарезки — 4 столбца; сводная матрица — требование, критерии, замечания
            assert len(cells) == 4 or 4 < len(cells) <= len(REQUIREMENT_CRITERIA) + 2, line


def test_json_roundtrip(sample_report):
    data = json.loads(render_report(sample_report, "json"))
    assert Report.model_validate(data) == sample_report


def test_docx(sample_report):
    from docx import Document

    doc = Document(io.BytesIO(render_report(sample_report, "docx")))
    text = "\n".join(p.text for p in doc.paragraphs)
    assert "Паспорт прогона" in text
    assert len(doc.tables) >= 4
    assert "D-001" in "\n".join(c.text for t in doc.tables for row in t.rows for c in row.cells) + text


def test_pdf(sample_report):
    data = render_report(sample_report, "pdf")
    assert data[:5] == b"%PDF-"
    import pymupdf

    doc = pymupdf.open(stream=data, filetype="pdf")
    text = "".join(page.get_text() for page in doc)
    assert "Паспорт прогона" in text
    assert "D-001" in text


def test_pdf_title_page(sample_report):
    """Первая страница: название, паспорт, вердикт, показатели из Report, что исправить, содержание."""
    import pymupdf

    from req_core.pdf import document_title

    doc = pymupdf.open(stream=render_report(sample_report, "pdf"), filetype="pdf")
    cover = " ".join(doc[0].get_text().split())
    p, s = sample_report.passport, sample_report.summary
    assert document_title(sample_report) == "Уведомление о расходах по карте"
    for want in (document_title(sample_report), p.document_name, p.model, p.agent_version,
                 "Не готово к разработке и тестированию", "Что исправить первым", "Критические дефекты",
                 "СОДЕРЖАНИЕ", "Паспорт прогона", f"стр. 1 из {doc.page_count}",
                 f"{s.findings_total} из {s.findings_total}"):
        assert want in cover, want
    for sid in s.critical_finding_ids:
        assert sid in cover
    # содержание ведёт на реальные страницы разделов
    links = [ln for ln in doc[0].get_links() if ln.get("kind") == pymupdf.LINK_GOTO]
    assert links and all(1 <= ln["page"] + 1 <= doc.page_count for ln in links)
    assert len(doc.get_toc()) >= 6  # закладки PDF по разделам
    # колонтитул с номерами на остальных страницах
    assert f"стр. 2 из {doc.page_count}" in doc[1].get_text()


def test_unknown_format(sample_report):
    with pytest.raises(ValueError):
        render_report(sample_report, "html")


def test_chat_stream(sample_report):
    llm = FakeLLM(text="R-002 противоречит критерию приёмки (D-001).")
    out = "".join(answer_stream(llm, sample_report, [{"role": "user", "content": "привет"},
                                                     {"role": "assistant", "content": "здравствуйте"}],
                                "Почему R-002 критичен?", ["Глоссарий"]))
    assert out == "R-002 противоречит критерию приёмки (D-001)."
    call = llm.calls[-1]
    assert "D-001" in call["system"] and "Глоссарий" in call["system"]
    assert call["messages"][-1]["content"] == "Почему R-002 критичен?"
    assert len(call["messages"]) == 3
