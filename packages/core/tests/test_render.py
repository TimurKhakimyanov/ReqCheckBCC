import io
import json
import re

import pytest
from req_contracts import Report

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
            assert len(cells) == 4, line


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
