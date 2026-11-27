"""Детерминированные проверки без LLM.

Правила не выносят вердикт сами — они кладут в граф подсказки (hint), которые получают
инспектор и рецензенты. Модель подтверждает или отклоняет подсказку, а верификатор
перепроверяет итог. Так дешёвые и воспроизводимые проверки повышают полноту поиска.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from .ingest import Document


@dataclass
class Hint:
    rule: str
    line: int
    text: str
    note: str


# Размытые формулировки: по ним требование нельзя проверить однозначно.
VAGUE = [
    r"быстр\w*", r"оперативн\w*", r"своевременн\w*", r"мгновенн\w*", r"в момент\b", r"сразу\b", r"немедленн\w*",
    r"удобн\w*", r"интуитивн\w*", r"понятн\w*", r"прост\w{2,3}\b", r"дружественн\w*", r"гибк\w*", r"надежн\w*", r"надёжн\w*",
    r"по возможности", r"при необходимости", r"как правило", r"обычно", r"в большинстве случаев", r"желательно",
    r"и т\.\s?д\.?", r"и т\.\s?п\.?", r"и так далее", r"и тому подобн\w*", r"и др\.", r"и далее",
    r"примерно", r"около\b", r"приблизительно", r"порядка\b", r"достаточн\w*", r"оптимальн\w*", r"эффективн\w*",
    r"минимальн\w* задержк\w*", r"высок\w+ производительност\w*", r"корректн\w*", r"соответствующ\w*", r"некотор\w*",
    r"несколько\b", r"различн\w*", r"современн\w*", r"максимально\b", r"адекватн\w*", r"разумн\w*", r"должным образом",
]
_VAGUE_RE = re.compile(r"(?<![\w-])(" + "|".join(VAGUE) + r")(?![\w-])", re.I)

_PLACEHOLDER_RE = re.compile(
    r"(заполня\w+\s+\w+|будет (определен|уточнен|описан)\w*|уточняется|tbd|todo|to be defined|не заполнен\w*|"
    r"\bн/д\b|<[^<>]{0,40}>)",
    re.I,
)
_EMPTY_CELL_ROW = re.compile(r"^\|(\s*\|){2,}\s*$")
_DASH_VALUE = re.compile(r"\|\s*(—|-|–)\s*\|")
_PROD_DASH = re.compile(r"(prod|swagger|url)[^|]{0,30}[:|]\s*(\*\*)?\s*(—|–)\s*", re.I)
_UNFILLED_CHOICE = re.compile(r"Да\s*/\s*Нет")
_HTTP_METHOD = re.compile(r"\b(GET|POST|PUT|PATCH|DELETE)\b")
_WRITE_WORD = re.compile(r"(save|create|update|delete|remove|set|add|сохран|создан|измен|удал|запис|замен)", re.I)
_STATUS_CODE = re.compile(r"(?<![\d.,])([1-5]\d{2})(?![\d.,])")
_STATUS_CTX = re.compile(r"(статус|результат|ответ|status|http|код|\*\*\d{3}|####\s*\d{3})", re.I)
_SHALL = re.compile(r"\b(долж\w+|обязан\w*|необходимо|требуется|shall|must)\b", re.I)
_TIME_UNIT = re.compile(r"(\d+\s*(мс|сек\w*|мин\w*|час\w*)|в течение\s+\w+)", re.I)


def run_rules(doc: Document) -> list[Hint]:
    hints: list[Hint] = []
    text_all = "\n".join(l.text for l in doc.lines)
    in_code = False

    get_lines: list[int] = []
    write_lines: list[int] = []
    codes_seen: dict[str, list[int]] = {}
    codes_described: set[str] = set()

    for ln in doc.lines:
        t = ln.text
        s = t.strip()
        if s.startswith("```"):
            in_code = not in_code
            continue
        if not s:
            continue

        if not in_code and not ln.is_heading:
            for m in _VAGUE_RE.finditer(t):
                hints.append(Hint("vague_word", ln.no, s[:200], f"размытая формулировка «{m.group(0)}» — проверьте однозначность и проверяемость"))

        if _PLACEHOLDER_RE.search(t) or _EMPTY_CELL_ROW.match(s):
            hints.append(Hint("placeholder", ln.no, s[:200], "раздел или поле не заполнены (заглушка вместо содержания)"))
        elif _PROD_DASH.search(t) or (_DASH_VALUE.search(t) and s.count("|") <= 4):
            hints.append(Hint("placeholder", ln.no, s[:200], "значение не указано (прочерк)"))
        if len(_UNFILLED_CHOICE.findall(t)) >= 2:
            hints.append(Hint("unfilled_checklist", ln.no, s[:200], "пункт чек-листа не отмечен: оставлены оба варианта «Да / Нет»"))

        if _HTTP_METHOD.search(t):
            if re.search(r"\bGET\b|curl\s+-G", t):
                get_lines.append(ln.no)
        if re.search(r"(/[\w-]+){1,}", t) and _WRITE_WORD.search(t) and ("/" in t):
            if re.search(r"/\w*(save|create|update|delete|remove|set|add)\w*", t, re.I):
                write_lines.append(ln.no)

        if _STATUS_CTX.search(t) or re.match(r"^(\*\*|#{2,6}\s*)?[1-5]\d{2}\b", s):
            for m in _STATUS_CODE.finditer(t):
                code = m.group(1)
                if code[0] in "2345" and not re.search(rf"{code}\s*(₸|тенге|тиын|ms|мс|bit)", t):
                    codes_seen.setdefault(code, []).append(ln.no)
            m = re.match(r"^(\*\*|#{2,6}\s*)?([1-5]\d{2})\b[.\s*]", s)
            if m:
                codes_described.add(m.group(2))

        if _TIME_UNIT.search(t) and not in_code and not ln.is_heading and "|" not in t:
            hints.append(Hint("time_bound", ln.no, s[:200], "временное условие — проверьте точку отсчёта, часовой пояс, условия измерения и долю запросов"))

    # Операция записи через GET — нарушение семантики HTTP.
    if get_lines and write_lines:
        ln = doc.line(write_lines[0])
        hints.append(Hint(
            "http_semantics", write_lines[0], (ln.text.strip() if ln else "")[:200],
            f"метод GET (строки {', '.join(map(str, get_lines[:3]))}) используется для операции изменения данных — "
            "проверьте семантику HTTP (GET должен быть безопасным и идемпотентным; параметры попадают в URL и журналы)",
        ))

    # Коды ответов, которые упомянуты, но не описаны отдельным пунктом.
    for code, where in sorted(codes_seen.items()):
        if code not in codes_described and len(codes_described) >= 2:
            ln = doc.line(where[0])
            hints.append(Hint(
                "status_code", where[0], (ln.text.strip() if ln else "")[:200],
                f"код ответа {code} упомянут, но не описан отдельным пунктом среди статусов ({', '.join(sorted(codes_described))})",
            ))

    # Разные единицы измерения денег в одном документе.
    units = {
        "тиын": [l.no for l in doc.lines if re.search(r"тиын", l.text, re.I)],
        "тенге": [l.no for l in doc.lines if re.search(r"тенге|₸|kzt", l.text, re.I)],
    }
    if units["тиын"] and units["тенге"]:
        ln = doc.line(units["тиын"][0])
        hints.append(Hint(
            "units", units["тиын"][0], (ln.text.strip() if ln else "")[:200],
            "в документе суммы заданы и в тиынах, и в тенге — проверьте единообразие единиц и правила пересчёта/округления",
        ))

    # Обещание «сразу» в одном месте и допустимая задержка в другом — кандидат в противоречие.
    instant = [l for l in doc.lines if not l.is_heading and re.search(r"в момент\b|мгновенн\w*|немедленн\w*|сразу\b|в реальном времени|real[- ]?time", l.text, re.I)]
    delayed = [l for l in doc.lines if not l.is_heading and re.search(r"в течение\s+(\d+\s*)?(секунд\w*|минут\w*|час\w*|сут\w*|дн\w*)|не позднее|не более\s+\d+\s*(сек|мин|час)", l.text, re.I)]
    for a in instant[:3]:
        for b in delayed[:3]:
            if a.no != b.no:
                hints.append(Hint(
                    "timing_conflict", a.no, a.text.strip()[:200],
                    f"здесь обещано немедленное действие, а в L{b.no} допускается задержка («{b.text.strip()[:90]}») — "
                    "сверьте два места: если они об одном событии, это противоречие по срокам",
                ))

    # Время у границы суток в примерах и критериях — классическое место ошибок отнесения к периоду.
    for ln in doc.lines:
        if re.search(r"\b(23[:.]5\d|00[:.]0\d)\b", ln.text):
            hints.append(Hint(
                "boundary_time", ln.no, ln.text.strip()[:200],
                "время у границы суток: определите, какой момент здесь — совершение операции, а какой — её проведение или обработка, "
                "найдите правило документа об отнесении операции к периоду и пересчитайте пример по этому правилу",
            ))

    # Требование без модального глагола обязательности — косвенный признак описательного текста.
    if not _SHALL.search(text_all):
        first = next((l for l in doc.lines if l.text.strip() and not l.is_heading), None)
        if first:
            hints.append(Hint(
                "no_shall", first.no, first.text.strip()[:200],
                "в документе нет формулировок обязательности («должен», «обязан») — требования записаны описательно, "
                "проверьте соответствие шаблону и наличие приоритетов",
            ))

    # Одинаковые подсказки по одной строке не дублируем.
    seen: set[tuple[str, int, str]] = set()
    out: list[Hint] = []
    for h in hints:
        k = (h.rule, h.line, h.note)
        if k not in seen:
            seen.add(k)
            out.append(h)
    return out


_CHECKLIST_SECTION = re.compile(r"ревью\s+требован|чек-?лист|checklist|requirements review", re.I)
_TABLE_SEP = re.compile(r"^\|?\s*:?-{3,}")


def find_checklist(doc: Document) -> list[tuple[int, str]]:
    """Находит в документе чек-лист ревью: строки таблицы с «Да / Нет» (незаполненный шаблон),
    а если таких нет — строки таблицы в разделе «Ревью требований» / «Чек-лист» (как в ReqCheck)."""
    rows: list[tuple[int, str]] = []
    for ln in doc.lines:
        if ln.text.strip().startswith("|") and _UNFILLED_CHOICE.search(ln.text):
            first = ln.text.strip().strip("|").split("|")[0].strip()
            if first and not _UNFILLED_CHOICE.search(first):
                rows.append((ln.no, first))
    if len(rows) >= 3:
        return rows
    rows = []
    for i, ln in enumerate(doc.lines):
        s = ln.text.strip()
        if not s.startswith("|") or _TABLE_SEP.match(s) or not _CHECKLIST_SECTION.search(ln.section or ""):
            continue
        nxt = doc.lines[i + 1].text.strip() if i + 1 < len(doc.lines) else ""
        if _TABLE_SEP.match(nxt):  # строка заголовка таблицы
            continue
        first = re.sub(r"[*_`]", "", s.strip("|").split("|")[0]).strip()
        if first:
            rows.append((ln.no, first))
    return rows if len(rows) >= 2 else []
