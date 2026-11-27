"""Детерминированная часть агента: подсказки для нарезки и проверки без LLM.

Правила общие для банковских шаблонов требований (идентификаторы «Ф-N», таблицы критериев приёмки,
таблицы параметров API, разделы НФТ/данных/интеграции), а не под конкретный документ.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from req_contracts import Criterion, FindingScope, FindingSource, RequirementKind, Severity

from .text import SectionIndex, clean_inline, shorten

# ---------------------------------------------------------------- внутренние модели


@dataclass
class ReqDraft:
    start: int
    end: int
    kind: RequirementKind
    summary: str
    source_id: str | None = None
    parts: list[ReqDraft] = field(default_factory=list)
    origin: str = "rule"
    id: str = ""
    parent_id: str | None = None

    @property
    def length(self) -> int:
        return max(1, self.end - self.start)


@dataclass
class FindingDraft:
    scope: FindingScope
    criterion: Criterion
    severity: Severity
    title: str
    explanation: str
    spans: list[tuple[int, int]] = field(default_factory=list)
    requirement_ids: list[str] = field(default_factory=list)
    suggestion: str | None = None
    source: FindingSource = FindingSource.RULE
    unverified_quotes: list[str] = field(default_factory=list)
    id: str = ""
    question: str = ""  # уточняющий вопрос автору, если рецензент его предложил
    addressee: str = ""
    origin: str = ""  # какой агент нашёл: inspector, reviewer:<роль>, rules


def overlap(a: tuple[int, int], b: tuple[int, int]) -> int:
    return max(0, min(a[1], b[1]) - max(a[0], b[0]))


# ---------------------------------------------------------------- разбор строк и таблиц


@dataclass
class Line:
    start: int
    end: int
    text: str


def iter_lines(text: str) -> list[Line]:
    out, pos = [], 0
    for raw in text.split("\n"):
        out.append(Line(pos, pos + len(raw), raw))
        pos += len(raw) + 1
    return out


_SEP_ROW = re.compile(r"^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$")


def split_row(line: str) -> list[str]:
    s = line.strip()
    if s.startswith("|"):
        s = s[1:]
    if s.endswith("|") and not s.endswith("\\|"):
        s = s[:-1]
    return [c.strip().replace("\\|", "|") for c in re.split(r"(?<!\\)\|", s)]


@dataclass
class Table:
    header: Line
    rows: list[Line]

    @property
    def header_cells(self) -> list[str]:
        return [clean_inline(c) for c in split_row(self.header.text)]


def find_tables(lines: list[Line]) -> list[Table]:
    tables: list[Table] = []
    i = 0
    while i < len(lines) - 1:
        if lines[i].text.lstrip().startswith("|") and _SEP_ROW.match(lines[i + 1].text):
            header = lines[i]
            j = i + 2
            rows = []
            while j < len(lines) and lines[j].text.lstrip().startswith("|"):
                rows.append(lines[j])
                j += 1
            tables.append(Table(header, rows))
            i = j
        else:
            i += 1
    return tables


def row_span(line: Line) -> tuple[int, int]:
    """Строка таблицы без внешних «|» и пробелов."""
    s, e = line.start, line.end
    t = line.text
    lead = len(t) - len(t.lstrip(" |"))
    trail = len(t) - len(t.rstrip(" |"))
    return s + lead, e - trail


# ---------------------------------------------------------------- классификация разделов

SKIP_SECTION = re.compile(
    r"ревью\s+требован|чек-?лист|review|согласующ|согласован|approv|общие сведения|паспорт|история изменен|"
    r"change history|содержание|оглавление|table of contents|глоссари|glossary|термин",
    re.I,
)
ACCEPTANCE_SECTION = re.compile(r"критери\w*\s+при[её]м|acceptance", re.I)
PARAM_SECTION = re.compile(r"параметр|parameters|query|path|header|заголовк|request|запрос|ответ|response", re.I)
PARA_SECTION = re.compile(
    r"нефункциональн|non-?functional|требовани\w* к данным|data requirement|требовани\w* к интеграц|integration|"
    r"безопасност|security|производительн|performance|надёжност|надежност|reliability|доступност|availability",
    re.I,
)
LIST_SECTION = re.compile(r"логик|правил|rules|logic|алгоритм|бизнес-правил|функциональн|functional", re.I)
STATUS_SECTION = re.compile(r"статус|status|коды? ответ|response codes", re.I)


def kind_for(path: str) -> RequirementKind:
    p = path.lower()
    if ACCEPTANCE_SECTION.search(p):
        return RequirementKind.ACCEPTANCE
    if re.search(r"нефункциональн|non-?functional|производительн|performance|надёжн|надежн", p):
        return RequirementKind.NON_FUNCTIONAL
    if re.search(r"к данным|data requirement", p):
        return RequirementKind.DATA
    if re.search(r"интеграц|integration", p):
        return RequirementKind.INTEGRATION
    if re.search(r"\bapi\b|rest|метод|endpoint|параметр|ответ|статус", p):
        return RequirementKind.API
    if re.search(r"\bui\b|ux|интерфейс|экран|дизайн", p):
        return RequirementKind.UI
    if re.search(r"функциональн|functional", p):
        return RequirementKind.FUNCTIONAL
    return RequirementKind.OTHER


# ---------------------------------------------------------------- подсказки нарезки

REQ_ID = r"(?:ФТ|НФТ|НФ|Ф|ТТ|БТ|ИТ|FR|NFR|REQ|BR|UC|US|SR|TR)[-‐–_]?\d+(?:\.\d+)*"
ID_LINE = re.compile(
    rf"^[ \t]*(?:[*\-•+][ \t]+|\d+[.)][ \t]+)?(?:\*\*|__)?[ \t]*(?P<id>{REQ_ID})\.?(?:\*\*|__)?[.:)\-—–]*[ \t]+(?P<body>\S.*)$"
)
LIST_ITEM = re.compile(r"^[ \t]*(?:[*\-•+]|\d+[.)])[ \t]+(?P<body>\S.*)$")
STATUS_LINE = re.compile(r"^[ \t]*(?:\*\*)?(?P<code>[1-5]\d\d)\.?(?:\*\*)?\.?[ \t]+(?P<body>\S.*)$")
IDENT = re.compile(r"^`?[A-Za-z_][\w.\-\[\]]*`?$")


def _body_span(line: Line, body_start_in_line: int) -> tuple[int, int]:
    s = line.start + body_start_in_line
    e = line.end
    t = line.text
    while e > s and t[e - line.start - 1] in " *":
        e -= 1
    return s, e


def _extend_paragraph(lines: list[Line], i: int, end: int) -> int:
    """Продолжение пункта на следующих строках (без пустой строки, нового пункта, заголовка, таблицы)."""
    j = i + 1
    while j < len(lines):
        t = lines[j].text
        if not t.strip() or t.lstrip().startswith(("|", "#", "```")) or LIST_ITEM.match(t) or ID_LINE.match(t):
            break
        end = lines[j].end
        j += 1
    return end


def segment_hints(text: str, sections: SectionIndex) -> list[ReqDraft]:
    lines = iter_lines(text)
    hints: list[ReqDraft] = []
    in_fence = False
    fence_lines: set[int] = set()
    for i, ln in enumerate(lines):
        if ln.text.lstrip().startswith(("```", "~~~")):
            in_fence = not in_fence
            fence_lines.add(i)
        elif in_fence:
            fence_lines.add(i)

    def add(span: tuple[int, int], kind: RequirementKind, source_id: str | None = None) -> None:
        s, e = span
        if e - s < 3:
            return
        body = clean_inline(text[s:e])
        first = re.split(r"(?<=[.!?])\s+", body, maxsplit=1)[0]
        hints.append(ReqDraft(s, e, kind, shorten(first, 120), source_id))

    # 1) требования с идентификатором в тексте или первой ячейке таблицы
    for i, ln in enumerate(lines):
        if i in fence_lines:
            continue
        path = sections.path(ln.start)
        if SKIP_SECTION.search(path):
            continue
        m = ID_LINE.match(ln.text)
        if m:
            s, e = _body_span(ln, m.start("body"))
            e = _extend_paragraph(lines, i, e)
            add((s, e), kind_for(path) if kind_for(path) != RequirementKind.OTHER else RequirementKind.FUNCTIONAL,
                m.group("id").replace("_", "-"))
            continue
        if ln.text.lstrip().startswith("|") and not _SEP_ROW.match(ln.text):
            cells = split_row(ln.text)
            if cells and re.fullmatch(REQ_ID, clean_inline(cells[0])) and len(cells) > 1:
                rs = row_span(ln)
                body_off = ln.text.find(cells[1]) if cells[1] else -1
                s = ln.start + body_off if body_off >= 0 else rs[0]
                add((s, rs[1]), kind_for(path) if kind_for(path) != RequirementKind.OTHER else RequirementKind.FUNCTIONAL,
                    clean_inline(cells[0]))

    covered = [(h.start, h.end) for h in hints]

    def is_covered(span: tuple[int, int]) -> bool:
        return any(overlap(span, c) > 0 for c in covered)

    # 2) таблицы: критерии приёмки и параметры API
    for t in find_tables(lines):
        path = sections.path(t.header.start)
        if SKIP_SECTION.search(path):
            continue
        title = sections.title_at(t.header.start)
        if ACCEPTANCE_SECTION.search(title):
            for r in t.rows:
                if any(clean_inline(c) for c in split_row(r.text)) and not is_covered(row_span(r)):
                    add(row_span(r), RequirementKind.ACCEPTANCE)
        elif PARAM_SECTION.search(title):
            for r in t.rows:
                cells = split_row(r.text)
                if cells and IDENT.match(cells[0]) and not is_covered(row_span(r)):
                    add(row_span(r), RequirementKind.API, clean_inline(cells[0]))

    covered = [(h.start, h.end) for h in hints]

    # 3) абзацы в разделах НФТ / данных / интеграции; пункты списков в разделах правил и логики; коды статусов
    i = 0
    while i < len(lines):
        ln = lines[i]
        t = ln.text
        if i in fence_lines or not t.strip() or t.lstrip().startswith(("#", "|")):
            i += 1
            continue
        path = sections.path(ln.start)
        title = sections.title_at(ln.start)
        if SKIP_SECTION.search(path):
            i += 1
            continue
        span = None
        sid = None
        if STATUS_SECTION.search(path) and (m := STATUS_LINE.match(t)):
            span = _body_span(ln, m.start("body"))
            sid = m.group("code")
        elif (m := LIST_ITEM.match(t)) and (LIST_SECTION.search(title) or PARA_SECTION.search(title)):
            span = (*_body_span(ln, m.start("body"))[:1], _extend_paragraph(lines, i, ln.end))
        elif PARA_SECTION.search(title) and not LIST_ITEM.match(t):
            end = _extend_paragraph(lines, i, ln.end)
            span = (ln.start + len(t) - len(t.lstrip()), end)
        if span and not is_covered(span):
            k = kind_for(path)
            add(span, k, sid)
            covered.append(span)
        i += 1

    hints.sort(key=lambda h: h.start)
    return hints


# ---------------------------------------------------------------- проверки без LLM

VAGUE_MAJOR = [
    r"быстр\w*", r"оперативн\w*", r"своевременн\w*", r"мгновенн\w*", r"моментальн\w*", r"незамедлительн\w*",
    r"удобн\w*", r"интуитивн\w*", r"понятн\w*", r"достаточн\w*", r"разумн\w*", r"приемлем\w*", r"надлежащ\w*",
    r"эффективн\w*", r"оптимальн\w*", r"гибк\w*", r"надёжн\w*", r"надежн\w*", r"современн\w*",
    r"максимально\s+\w+", r"минимально\s+\w+", r"как правило", r"при необходимости", r"по возможности",
    r"по мере необходимости", r"в случае необходимости", r"примерно", r"приблизительно", r"около",
    r"некотор\w+", r"нескольк\w+", r"многи\w+", r"большинств\w+", r"высок\w+ производительн\w+",
    r"fast", r"quick(?:ly)?", r"user-friendly", r"easy", r"easily", r"intuitive", r"appropriate", r"adequate",
    r"sufficient", r"reasonable", r"efficient(?:ly)?", r"flexible", r"robust", r"seamless(?:ly)?",
    r"as needed", r"as appropriate", r"if possible", r"where possible", r"approximately", r"several",
]
VAGUE_MINOR = [r"и т\.\s?д\.?", r"и т\.\s?п\.?", r"и др\.?", r"и прочее", r"и/или", r"etc\.?", r"and/or"]
_VAGUE_RE = re.compile(
    r"(?<![\w-])(?:(?P<major>" + "|".join(VAGUE_MAJOR) + r")|(?P<minor>" + "|".join(VAGUE_MINOR) + r"))(?![\w])",
    re.I,
)
TBD_RE = re.compile(
    r"(?<!\w)(?:TBD|TBA|TODO|FIXME|XXX)(?!\w)|(?:будет|будут)\s+(?:определен\w*|уточнен\w*|описан\w*|добавлен\w*|согласован\w*)"
    r"|(?:заполня|определя|уточня|описыва|добавля|дорабатыва)\w*\s+(?:позже|позднее|в дальнейшем|тестировщик\w*|"
    r"аналитик\w*|разработчик\w*|отдельно)|уточняется|на усмотрение\s+\w+|to be (?:defined|determined|confirmed)",
    re.I,
)
VERSION_RE = re.compile(
    r"(?:верси[яи]|version|редакци[яи]|ред\.)\s*(?:документа)?\s*[:№#]?\s*v?\d+(?:\.\d+)*|(?<!\w)v\d+\.\d+(?!\w)",
    re.I,
)
VERSION_WORD = re.compile(r"верси[яи]|version|редакци", re.I)
PLACEHOLDER_CELL = re.compile(r"^(?:[—–\-]|n/?a|tbd|\.\.\.|…)$|:\s*[—–]\s*\.?$", re.I)
TEMPLATE_CHOICE = re.compile(r"Да\s*/\s*Нет|Yes\s*/\s*No", re.I)


def _line_of(text: str, offset: int) -> tuple[int, int]:
    s = text.rfind("\n", 0, offset) + 1
    e = text.find("\n", offset)
    return s, (e if e >= 0 else len(text))


def _trim(text: str, span: tuple[int, int]) -> tuple[int, int]:
    s, e = span
    while s < e and text[s] in " \t|*#>-":
        s += 1
    while e > s and text[e - 1] in " \t|*":
        e -= 1
    return s, e


def rule_findings(text: str, sections: SectionIndex, reqs: list[ReqDraft]) -> list[FindingDraft]:
    out: list[FindingDraft] = []
    flat = [r for r in reqs if not r.parts] + [p for r in reqs for p in r.parts]
    top = list(reqs)

    def req_at(span: tuple[int, int]) -> list[ReqDraft]:
        inner = [r for r in flat if r.start <= span[0] and span[1] <= r.end]
        if inner:
            return inner[:1]
        return [r for r in top if r.start <= span[0] and span[1] <= r.end][:1]

    # 1) размытые формулировки внутри требований
    for r in top:
        hits_major, hits_minor = [], []
        for m in _VAGUE_RE.finditer(text, r.start, r.end):
            (hits_major if m.group("major") else hits_minor).append((m.start(), m.end()))
        for hits, sev in ((hits_major, Severity.MAJOR), (hits_minor, Severity.MINOR)):
            if not hits:
                continue
            words = ", ".join(f"«{text[s:e]}»" for s, e in hits[:5])
            target = req_at(hits[0]) or [r]
            out.append(FindingDraft(
                scope=FindingScope.REQUIREMENT, criterion=Criterion.UNAMBIGUOUS, severity=sev,
                title="Размытая формулировка: " + words,
                explanation=f"Слова {words} не задают измеримого значения и допускают разное толкование; "
                "по такой формулировке нельзя однозначно реализовать и проверить требование.",
                spans=hits[:5], requirement_ids=[target[0].id],
                suggestion="Заменить на конкретные измеримые значения (числа, единицы, условия, перечень).",
            ))

    # 2) «TBD», «заполняются позже» и т. п.
    for m in TBD_RE.finditer(text):
        span = _trim(text, _line_of(text, m.start()))
        if span[1] - span[0] > 300:
            span = (m.start(), m.end())
        rr = req_at((m.start(), m.end()))
        section = sections.path(m.start())
        out.append(FindingDraft(
            scope=FindingScope.REQUIREMENT if rr else FindingScope.SET,
            criterion=Criterion.COMPLETE if rr else Criterion.SET_COMPLETE,
            severity=Severity.MAJOR,
            title=f"Раздел не заполнен: «{text[m.start():m.end()]}»",
            explanation=f"В разделе «{section}» вместо содержания стоит отсылка на будущее заполнение; "
            "без него требование нельзя считать полным и проверяемым.",
            spans=[span], requirement_ids=[rr[0].id] if rr else [],
            suggestion="Заполнить раздел до передачи в разработку или явно исключить его с обоснованием.",
        ))

    # 3) пустые поля и незаполненные строки шаблона в таблицах
    lines = iter_lines(text)
    choice_spans: list[tuple[int, int]] = []
    for t in find_tables(lines):
        section = sections.path(t.header.start)
        empty_rows = [r for r in t.rows if not any(clean_inline(c) for c in split_row(r.text))]
        placeholders: list[tuple[str, tuple[int, int]]] = []
        for r in t.rows:
            cells = [clean_inline(c) for c in split_row(r.text)]
            if TEMPLATE_CHOICE.search(r.text):
                choice_spans.append(row_span(r))
            # только таблицы «поле — значение»: в широких таблицах прочерк — осмысленное «нет» (напр. DB field)
            if len(cells) == 2 and cells[0] and (not cells[1] or PLACEHOLDER_CELL.search(cells[1])):
                placeholders.append((cells[0], row_span(r)))
        if empty_rows:
            out.append(FindingDraft(
                scope=FindingScope.SET, criterion=Criterion.SET_COMPLETE, severity=Severity.MINOR,
                title=f"Пустые строки таблицы в разделе «{sections.title_at(t.header.start) or section}»",
                explanation=f"Таблица «{shorten(clean_inline(t.header.text), 80)}» содержит {len(empty_rows)} "
                "незаполненных строк(и) шаблона.",
                spans=[row_span(t.header)],
                suggestion="Заполнить таблицу (ответственные, значения) или удалить неиспользуемые строки.",
            ))
        if placeholders:
            names = ", ".join(f"«{n}»" for n, _ in placeholders[:6])
            out.append(FindingDraft(
                scope=FindingScope.SET, criterion=Criterion.SET_COMPLETE, severity=Severity.MINOR,
                title=f"Не заполнены поля: {names}",
                explanation=f"В разделе «{section}» значения полей {names} заданы прочерком или заглушкой.",
                spans=[s for _, s in placeholders[:4]],
                suggestion="Указать фактические значения полей или пометить их как неприменимые с причиной.",
            ))
    if choice_spans:
        out.append(FindingDraft(
            scope=FindingScope.SET, criterion=Criterion.SET_VALIDATABLE, severity=Severity.MINOR,
            title="Чек-лист шаблона не заполнен (варианты «Да / Нет» не выбраны)",
            explanation=f"В {len(choice_spans)} строках чек-листа оставлены варианты ответа шаблона без выбора; "
            "ревью требований формально не проведено.",
            spans=choice_spans[:2],
            suggestion="Провести ревью по чек-листу и проставить отметки.",
        ))

    # 4) версия документа
    if not VERSION_RE.search(text):
        m = VERSION_WORD.search(text)
        if m:
            span = _trim(text, _line_of(text, m.start()))
        else:
            first = next((ln for ln in lines if ln.text.strip()), lines[0])
            span = _trim(text, (first.start, first.end))
        out.append(FindingDraft(
            scope=FindingScope.SET, criterion=Criterion.SET_MODIFIABLE, severity=Severity.MINOR,
            title="Не указана версия документа",
            explanation="В документе не найден номер версии (редакции); изменения требований нельзя отследить, "
            "а отчёт — однозначно привязать к редакции.",
            spans=[span],
            suggestion="Добавить номер версии, дату и историю изменений.",
        ))
    return out


# ---------------------------------------------------------------- чек-лист «Ревью требований»


def extract_checklist(text: str, sections: SectionIndex) -> list[tuple[str, tuple[int, int]]]:
    items: list[tuple[str, tuple[int, int]]] = []
    for t in find_tables(iter_lines(text)):
        title = sections.title_at(t.header.start)
        if not re.search(r"ревью\s+требован|чек-?лист|checklist|requirements review", title, re.I):
            continue
        for r in t.rows:
            cells = split_row(r.text)
            q = clean_inline(cells[0]) if cells else ""
            if q:
                items.append((q, row_span(r)))
    return items
