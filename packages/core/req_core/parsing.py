"""Чтение документа требований: PDF, DOCX, MD, TXT → ParsedDocument.

Текст приводится к markdown-подобному виду: заголовки `#`, списки `*`, таблицы `| a | b |`.
Это даёт единые правила нарезки и путей разделов для всех форматов.
"""

from __future__ import annotations

import hashlib
import re
from collections import Counter
from pathlib import Path

from req_contracts import DocumentFormat, ParsedDocument

from .text import normalize_document_text

SUPPORTED_SUFFIXES = {
    ".pdf": DocumentFormat.PDF,
    ".docx": DocumentFormat.DOCX,
    ".md": DocumentFormat.MD,
    ".markdown": DocumentFormat.MD,
    ".txt": DocumentFormat.TXT,
    ".text": DocumentFormat.TXT,
}


class DocumentParseError(ValueError):
    pass


def detect_format(path: Path, data: bytes) -> DocumentFormat:
    fmt = SUPPORTED_SUFFIXES.get(path.suffix.lower())
    if fmt:
        return fmt
    if data[:5] == b"%PDF-":
        return DocumentFormat.PDF
    if data[:2] == b"PK":
        return DocumentFormat.DOCX
    return DocumentFormat.TXT


def decode_text(data: bytes) -> str:
    for enc in ("utf-8-sig", "cp1251"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def parse_document(path: Path, *, name: str | None = None) -> ParsedDocument:
    path = Path(path)
    if not path.is_file():
        raise DocumentParseError(f"Файл не найден: {path}")
    data = path.read_bytes()
    if not data:
        raise DocumentParseError(f"Пустой файл: {path}")
    fmt = detect_format(path, data)
    page_offsets: list[int] | None = None
    if fmt == DocumentFormat.PDF:
        text, page_offsets = _parse_pdf(path)
    elif fmt == DocumentFormat.DOCX:
        text = normalize_document_text(_parse_docx(path))
    else:
        text = normalize_document_text(decode_text(data))
    if not text.strip():
        raise DocumentParseError("В документе не найден текст (для PDF-скана нужен OCR — не поддерживается)")
    return ParsedDocument(
        name=name or path.name,
        format=fmt,
        sha256=hashlib.sha256(data).hexdigest(),
        text=text,
        page_offsets=page_offsets,
    )


# ---------------------------------------------------------------- таблицы


def _cell(s: str | None) -> str:
    s = (s or "").replace("\r", " ").replace("\n", " ")
    s = " ".join(s.split())
    return s.replace("|", "\\|")


def rows_to_markdown(rows: list[list[str | None]]) -> str:
    rows = [[_cell(c) for c in r] for r in rows if r is not None]
    rows = [r for r in rows if any(r)] or rows[:1]
    if not rows:
        return ""
    width = max(len(r) for r in rows)
    rows = [r + [""] * (width - len(r)) for r in rows]
    head, body = rows[0], rows[1:]
    out = ["| " + " | ".join(head) + " |", "| " + " | ".join([":---"] * width) + " |"]
    out += ["| " + " | ".join(r) + " |" for r in body]
    return "\n".join(out)


# ---------------------------------------------------------------- DOCX

_HEADING_STYLE = re.compile(r"(?:heading|заголовок)\s*(\d)", re.I)


def _parse_docx(path: Path) -> str:
    try:
        from docx import Document
        from docx.table import Table
        from docx.text.paragraph import Paragraph
    except ImportError as e:  # pragma: no cover
        raise DocumentParseError("python-docx не установлен") from e
    try:
        doc = Document(str(path))
    except Exception as e:
        raise DocumentParseError(f"Не удалось открыть DOCX: {e}") from e

    blocks: list[str] = []
    numbered = 0
    for child in doc.element.body.iterchildren():
        tag = child.tag.rsplit("}", 1)[-1]
        if tag == "p":
            p = Paragraph(child, doc)
            text = p.text.strip()
            if not text:
                numbered = 0
                continue
            style = (p.style.name if p.style is not None else "") or ""
            m = _HEADING_STYLE.search(style)
            if m:
                blocks.append("#" * min(int(m.group(1)) + 1, 6) + " " + text)
                numbered = 0
            elif style.lower() == "title" or style.lower() == "название":
                blocks.append("# " + text)
            elif "number" in style.lower() or "нумер" in style.lower():
                numbered += 1
                blocks.append(f"{numbered}. {text}")
            elif "list" in style.lower() or "спис" in style.lower() or child.find(".//{*}numPr") is not None:
                blocks.append("* " + text)
            else:
                numbered = 0
                blocks.append(text)
        elif tag == "tbl":
            numbered = 0
            table = Table(child, doc)
            rows: list[list[str]] = []
            for row in table.rows:
                cells, seen = [], set()
                for c in row.cells:
                    if id(c._tc) in seen:  # объединённые ячейки python-docx повторяет
                        continue
                    seen.add(id(c._tc))
                    cells.append(c.text)
                rows.append(cells)
            md = rows_to_markdown(rows)
            if md:
                blocks.append(md)
    # абзацы-пункты списка идут подряд без пустой строки, остальное — через пустую строку
    out: list[str] = []
    for b in blocks:
        is_item = b.startswith("* ") or re.match(r"^\d+\. ", b)
        if out and is_item and (out[-1].startswith("* ") or re.match(r"^\d+\. ", out[-1].split("\n")[-1])):
            out[-1] += "\n" + b
        else:
            out.append(b)
    return "\n\n".join(out)


# ---------------------------------------------------------------- PDF


def _parse_pdf(path: Path) -> tuple[str, list[int]]:
    try:
        import pymupdf
    except ImportError:  # pragma: no cover
        try:
            import fitz as pymupdf  # type: ignore[no-redef]
        except ImportError as e:
            raise DocumentParseError("PyMuPDF не установлен") from e
    try:
        doc = pymupdf.open(str(path))
    except Exception as e:
        raise DocumentParseError(f"Не удалось открыть PDF: {e}") from e

    pages_raw = []
    size_chars: Counter[float] = Counter()
    for page in doc:
        tables = []
        try:
            tables = list(page.find_tables().tables)
        except Exception:
            tables = []
        rects = [pymupdf.Rect(t.bbox) for t in tables]
        blocks = []
        for b in page.get_text("dict", sort=True)["blocks"]:
            if b.get("type") != 0:
                continue
            lines = []
            for ln in b["lines"]:
                bbox = pymupdf.Rect(ln["bbox"])
                center = pymupdf.Point((bbox.x0 + bbox.x1) / 2, (bbox.y0 + bbox.y1) / 2)
                if any(center in r for r in rects):
                    continue
                spans = [s for s in ln["spans"] if s["text"].strip()]
                if not spans:
                    continue
                text = "".join(s["text"] for s in ln["spans"]).strip()
                size = max(round(s["size"], 1) for s in spans)
                bold = all(s["flags"] & 16 for s in spans)
                size_chars[size] += len(text)
                lines.append((text, size, bold))
            if lines:
                blocks.append((b["bbox"][1], b["bbox"][0], lines))
        table_items = []
        for t in tables:
            try:
                md = rows_to_markdown(t.extract())
            except Exception:
                md = ""
            if md:
                table_items.append((t.bbox[1], t.bbox[0], md))
        pages_raw.append((blocks, table_items))

    body_size = size_chars.most_common(1)[0][0] if size_chars else 10.0
    heading_sizes = sorted({s for s in size_chars if s >= body_size + 1.5}, reverse=True)[:4]
    level_of = {s: i + 1 for i, s in enumerate(heading_sizes)}

    texts: list[str] = []
    for blocks, table_items in pages_raw:
        items: list[tuple[float, float, str]] = []
        for y, x, lines in blocks:
            sizes = {s for _, s, _ in lines}
            joined = " ".join(t for t, _, _ in lines)
            if len(sizes) == 1 and next(iter(sizes)) in level_of and len(joined) < 200:
                items.append((y, x, "#" * level_of[next(iter(sizes))] + " " + joined))
                continue
            out_lines = []
            for t, _, _ in lines:
                t = re.sub(r"^[•●▪◦‣∙·]\s*", "* ", t)
                out_lines.append(t)
            items.append((y, x, "\n".join(out_lines)))
        items += table_items
        items.sort(key=lambda it: (round(it[0], 0), it[1]))
        texts.append(normalize_document_text("\n\n".join(it[2] for it in items)) if items else "")

    full, offsets = "", []
    for t in texts:
        offsets.append(len(full))
        if t.strip():
            full += t.rstrip("\n") + "\n\n"
    full = full.rstrip("\n") + "\n"
    return full, offsets
