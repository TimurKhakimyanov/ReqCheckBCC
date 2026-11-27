import pytest
from req_contracts import DocumentFormat

from req_core import parse_document
from req_core.parsing import DocumentParseError
from req_core.render import _find_font


def test_parse_markdown_sample(sample_path):
    doc = parse_document(sample_path)
    assert doc.format == DocumentFormat.MD
    assert doc.name == "requirements.md"
    assert "**Ф-1.** Держатель активной карты KZT" in doc.text
    assert len(doc.sha256) == 64
    assert doc.page_offsets is None
    assert "\r" not in doc.text


def test_parse_txt_cp1251(tmp_path):
    p = tmp_path / "req.txt"
    p.write_bytes("ФТ-1. Система хранит порог.\r\n".encode("cp1251"))
    doc = parse_document(p, name="Документ")
    assert doc.format == DocumentFormat.TXT
    assert doc.name == "Документ"
    assert doc.text == "ФТ-1. Система хранит порог.\n"


def test_parse_missing_and_empty(tmp_path):
    with pytest.raises(DocumentParseError):
        parse_document(tmp_path / "nope.md")
    empty = tmp_path / "empty.md"
    empty.write_text("", encoding="utf-8")
    with pytest.raises(DocumentParseError):
        parse_document(empty)


def test_parse_docx_headings_lists_tables(tmp_path):
    from docx import Document

    d = Document()
    d.add_heading("Требования", level=1)
    d.add_paragraph("Ф-1. Клиент задаёт порог от 1 000 до 1 000 000 ₸.", style="List Bullet")
    d.add_paragraph("Ф-2. Push отправляется один раз в месяц.", style="List Bullet")
    d.add_paragraph("Обычный абзац.")
    t = d.add_table(rows=2, cols=2)
    t.cell(0, 0).text, t.cell(0, 1).text = "Поле", "Значение"
    t.cell(1, 0).text, t.cell(1, 1).text = "REST type", "GET | POST"
    p = tmp_path / "req.docx"
    d.save(p)

    doc = parse_document(p)
    assert doc.format == DocumentFormat.DOCX
    assert "## Требования" in doc.text
    assert "* Ф-1. Клиент задаёт порог от 1 000 до 1 000 000 ₸.\n* Ф-2." in doc.text
    assert "| Поле | Значение |" in doc.text
    assert "| REST type | GET \\| POST |" in doc.text
    assert doc.text.index("Обычный абзац") < doc.text.index("| Поле")


def test_parse_pdf_pages_tables_headings(tmp_path):
    from fpdf import FPDF

    regular, bold = _find_font()
    pdf = FPDF()
    pdf.add_font("DejaVu", "", regular)
    pdf.add_font("DejaVu", "B", bold)
    pdf.add_page()
    pdf.set_font("DejaVu", "B", 18)
    pdf.cell(0, 10, "Функциональные требования", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("DejaVu", "", 11)
    pdf.multi_cell(0, 6, "Ф-1. Держатель карты задаёт порог от 1 000 до 1 000 000 ₸ включительно.",
                   new_x="LMARGIN", new_y="NEXT")
    pdf.multi_cell(0, 6, "Ф-2. Месяц определяется по дате покупки.", new_x="LMARGIN", new_y="NEXT")
    pdf.add_page()
    pdf.set_font("DejaVu", "B", 18)
    pdf.cell(0, 10, "Критерии приемки", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("DejaVu", "", 11)
    with pdf.table() as table:
        for row in (("Условие", "Действие", "Результат"),
                    ("Расходы 48 500 ₸", "Покупка 1 500 ₸", "Один push"),
                    ("Расходы 19 900 ₸", "Перевод 500 ₸", "Счётчик 19 900 ₸")):
            r = table.row()
            for c in row:
                r.cell(c)
    p = tmp_path / "req.pdf"
    pdf.output(str(p))

    doc = parse_document(p)
    assert doc.format == DocumentFormat.PDF
    assert doc.page_offsets is not None and len(doc.page_offsets) == 2
    assert doc.page_offsets[0] == 0
    first, second = doc.text[: doc.page_offsets[1]], doc.text[doc.page_offsets[1]:]
    assert "Ф-1. Держатель карты" in first
    assert "# Функциональные требования" in first
    assert "Критерии приемки" in second
    assert "| Расходы 48 500 ₸ | Покупка 1 500 ₸ | Один push |" in second
