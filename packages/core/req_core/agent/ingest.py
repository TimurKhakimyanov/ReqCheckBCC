"""Документ для агентов: пронумерованные строки с разделами (методика bbc-agent).

Номер строки — якорь, на который ссылается каждое замечание. Файл читает `req_core.parsing`
(PDF, DOCX, MD, TXT → markdown-подобный текст), здесь текст режется на строки; каждая строка помнит
своё смещение в `ParsedDocument.text`, поэтому в отчёт идут точные символьные позиции и страницы.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from req_contracts import DocumentFormat, ParsedDocument

from ..text import page_for


@dataclass
class Line:
    no: int  # сквозной номер строки (с 1)
    text: str
    section: str = ""  # путь заголовков: «Часть A › Требования › Функциональные»
    page: int | None = None
    is_heading: bool = False
    start: int = 0  # смещение начала строки в ParsedDocument.text
    end: int = 0  # смещение конца строки (без перевода строки)


@dataclass
class Document:
    name: str
    fmt: str
    title: str
    sha256: str
    lines: list[Line] = field(default_factory=list)
    pages: int | None = None
    unit: str = "строка"  # единица нумерации: строка файла или абзац (для PDF и DOCX)
    text: str = ""

    def place(self, start: int, end: int | None = None) -> str:
        """«строка 31», «строки 31–33», «абзац 12»."""
        end = end or start
        if start == end:
            return f"{self.unit} {start}"
        plural = "строки" if self.unit == "строка" else "абзацы"
        return f"{plural} {start}–{end}"

    def numbered(self, start: int | None = None, end: int | None = None) -> str:
        """Текст для модели: каждая непустая строка с префиксом L<номер>|."""
        out = []
        for ln in self.lines:
            if start and ln.no < start:
                continue
            if end and ln.no > end:
                break
            if ln.text.strip():
                out.append(f"L{ln.no}| {ln.text}")
        return "\n".join(out)

    def line(self, no: int) -> Line | None:
        return self.lines[no - 1] if 1 <= no <= len(self.lines) else None

    def span_text(self, start: int, end: int) -> str:
        return " ".join(ln.text.strip() for ln in self.lines[start - 1:end] if ln.text.strip())

    def char_span(self, start: int, end: int) -> tuple[int, int]:
        """Символьные границы строк start..end в исходном тексте (без пустых краёв)."""
        a, b = self.line(start), self.line(end)
        if not a or not b:
            return 0, 0
        cs, ce = a.start, b.end
        while cs < ce and self.text[cs].isspace():
            cs += 1
        while ce > cs and self.text[ce - 1].isspace():
            ce -= 1
        return cs, ce

    def line_at(self, offset: int) -> int:
        """Номер строки, содержащей символ offset."""
        lo, hi = 0, len(self.lines) - 1
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if self.lines[mid].start <= offset:
                lo = mid
            else:
                hi = mid - 1
        return self.lines[lo].no if self.lines else 1

    def where(self, start: int, end: int | None = None) -> str:
        """Человекочитаемое место: «стр. 2, строка 31 — раздел …»."""
        end = end or start
        ln = self.line(start)
        if not ln:
            return "место не определено"
        rng = self.place(start, end)
        page = f"стр. {ln.page}, " if ln.page else ""
        sec = f" — «{ln.section}»" if ln.section else ""
        return f"{page}{rng}{sec}"


_MD_HEADING = re.compile(r"^(#{1,6})\s+\S")
_TXT_HEADING = re.compile(r"^\s*(\d+(\.\d+)*\.?|[A-ZА-Я]\.)\s+[A-ZА-ЯЁ].{0,80}$")
_FENCE = re.compile(r"^\s*(```|~~~)")


def from_parsed(pd: ParsedDocument) -> Document:
    """Строки документа из нормализованного текста ReqCheck."""
    text = pd.text
    raw: list[tuple[str, int, int]] = []  # (строка, смещение, уровень заголовка)
    offset = 0
    in_code = False
    has_md_headings = False
    for line in text.split("\n"):
        level = 0
        if _FENCE.match(line):
            in_code = not in_code
        elif not in_code:
            m = _MD_HEADING.match(line)
            if m:
                level = len(m.group(1))
                has_md_headings = True
        raw.append((line, offset, level))
        offset += len(line) + 1
    if not has_md_headings and pd.format == DocumentFormat.TXT:  # обычный текст: «1.2 Заголовок»
        fixed = []
        for line, off, _ in raw:
            s = line.strip()
            level = 0
            if s and len(s) < 90 and not s.endswith((".", ";", ",", ":")) and _TXT_HEADING.match(s):
                level = min(s.split()[0].count(".") + 1, 6)
            fixed.append((line, off, level))
        raw = fixed

    stack: list[tuple[int, str]] = []
    lines: list[Line] = []
    title = ""
    for i, (line, off, level) in enumerate(raw, start=1):
        if level:
            clean = re.sub(r"^#+\s*", "", line).strip().strip("*").strip()
            while stack and stack[-1][0] >= level:
                stack.pop()
            stack.append((level, clean))
            if not title:
                title = clean
        # первый уровень (название документа) в путь не включаем — он одинаков для всех строк
        parts = [name for _, name in stack]
        section = " › ".join(parts[1:] if len(parts) > 1 else parts)
        lines.append(Line(no=i, text=line.rstrip(), section=section, page=page_for(off, pd.page_offsets),
                          is_heading=bool(level), start=off, end=off + len(line.rstrip())))
    if not title:
        title = next((ln.text.strip() for ln in lines if ln.text.strip()), pd.name)
    paragraphs = pd.format in (DocumentFormat.PDF, DocumentFormat.DOCX)
    return Document(
        name=pd.name, fmt=pd.format.value, title=re.sub(r"[*_`]", "", title)[:200], sha256=pd.sha256, lines=lines,
        pages=len(pd.page_offsets) if pd.page_offsets else None, unit="абзац" if paragraphs else "строка", text=text,
    )
