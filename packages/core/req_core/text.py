"""Текстовые утилиты: нормализация документа, поиск цитат, разделы и страницы.

Все смещения считаются от `ParsedDocument.text`. Поиск цитат терпим к различиям, которые LLM вносит
при цитировании: markdown-разметка (`**`, `|`, обратные кавычки), вид кавычек и тире, «ё/е»,
переносы строк и повторные пробелы. Найденная цитата заменяется точным фрагментом документа,
поэтому для подтверждённой цитаты всегда `text[char_start:char_end] == quote`.
"""

from __future__ import annotations

import re
import unicodedata
from bisect import bisect_right
from dataclasses import dataclass

from rapidfuzz import fuzz

# ---------------------------------------------------------------- нормализация документа

_SPACE_CHARS = dict.fromkeys(map(ord, "              　\t"), " ")
_ZERO_WIDTH = dict.fromkeys(map(ord, "​‌‍⁠﻿­"), None)


def normalize_document_text(text: str) -> str:
    """Нормализует извлечённый текст: переводы строк, невидимые символы, хвостовые пробелы."""
    text = unicodedata.normalize("NFC", text)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = text.translate(_ZERO_WIDTH).translate(_SPACE_CHARS)
    lines = [line.rstrip() for line in text.split("\n")]
    text = "\n".join(lines)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip("\n") + "\n"


# ---------------------------------------------------------------- нормализация для поиска цитат

_MATCH_MAP: dict[str, str] = {}
for _c in "«»„“”‟″\"":
    _MATCH_MAP[_c] = '"'
for _c in "‘’‚‛′'":
    _MATCH_MAP[_c] = "'"
for _c in "‐‑‒–—―−":
    _MATCH_MAP[_c] = "-"
_MATCH_MAP["ё"] = "е"
_MATCH_MAP["Ё"] = "е"
_MATCH_MAP["…"] = "..."
_DROP = set("*`_\\")  # markdown-разметка, которую модель часто опускает
_AS_SPACE = set("|#\n\t\r ")


def normalize_for_match(s: str) -> tuple[str, list[int]]:
    """Возвращает нормализованную строку и индекс исходного символа для каждого её символа."""
    out: list[str] = []
    idx: list[int] = []
    prev_space = True
    for i, ch in enumerate(s):
        if ch in _DROP:
            continue
        if ch in _AS_SPACE or ch.isspace():
            if not prev_space:
                out.append(" ")
                idx.append(i)
                prev_space = True
            continue
        mapped = _MATCH_MAP.get(ch, ch).lower()
        for m in mapped:
            out.append(m)
            idx.append(i)
        prev_space = False
    # хвостовой пробел не нужен
    if out and out[-1] == " ":
        out.pop()
        idx.pop()
    return "".join(out), idx


@dataclass
class QuoteMatch:
    start: int
    end: int
    score: float  # 100 — точное совпадение после нормализации


class QuoteLocator:
    """Ищет цитаты модели в тексте документа (точно, по фрагментам вокруг многоточия, нечётко)."""

    FUZZY_CUTOFF = 88.0

    def __init__(self, text: str):
        self.text = text
        self.norm, self.idx = normalize_for_match(text)

    def _span(self, a: int, b: int) -> tuple[int, int]:
        start = self.idx[a]
        end = self.idx[b - 1] + 1
        # не начинаем и не заканчиваем цитату на пробеле/разметке
        while start < end and self.text[start] in " \n|*`_#":
            start += 1
        while end > start and self.text[end - 1] in " \n|*`_#":
            end -= 1
        return start, end

    def _find_all(self, q: str) -> list[int]:
        res, pos = [], self.norm.find(q)
        while pos >= 0:
            res.append(pos)
            pos = self.norm.find(q, pos + 1)
        return res

    def _closest(self, positions: list[int], hint: int | None) -> int:
        if hint is None or len(positions) == 1:
            return positions[0]
        return min(positions, key=lambda p: abs(self.idx[p] - hint))

    def locate(self, quote: str, hint: int | None = None) -> QuoteMatch | None:
        if not quote:
            return None
        q, _ = normalize_for_match(quote.strip().strip('"«»'))
        q = q.strip(" .,;:")
        if len(q) < 3:
            return None
        positions = self._find_all(q)
        if positions:
            p = self._closest(positions, hint)
            s, e = self._span(p, p + len(q))
            return QuoteMatch(s, e, 100.0)
        # цитата с многоточием: ищем первый и последний фрагменты по порядку
        parts = [p.strip(" .,;:") for p in re.split(r"\.\.\.", q)]
        parts = [p for p in parts if len(p) >= 6]
        if len(parts) >= 2:
            first = self._find_all(parts[0])
            if first:
                a = self._closest(first, hint)
                b = self.norm.find(parts[-1], a + len(parts[0]))
                if b >= 0 and b - a < len(q) * 4 + 200:
                    s, e = self._span(a, b + len(parts[-1]))
                    return QuoteMatch(s, e, 95.0)
            longest = max(parts, key=len)
            pos = self._find_all(longest)
            if pos and len(longest) >= 15:
                p = self._closest(pos, hint)
                s, e = self._span(p, p + len(longest))
                return QuoteMatch(s, e, 90.0)
        # нечёткий поиск (модель слегка перефразировала или ошиблась в символе)
        if len(q) >= 12 and len(self.norm) >= len(q):
            res = fuzz.partial_ratio_alignment(q, self.norm, score_cutoff=self.FUZZY_CUTOFF)
            if res is not None and res.dest_end > res.dest_start:
                # выравнивание не должно быть заметно короче цитаты
                if (res.dest_end - res.dest_start) >= 0.8 * len(q):
                    s, e = self._span(res.dest_start, res.dest_end)
                    return QuoteMatch(s, e, float(res.score))
        return None


# ---------------------------------------------------------------- разделы и страницы

_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$")
_FENCE_RE = re.compile(r"^\s*(```|~~~)")


def clean_inline(s: str) -> str:
    """Убирает markdown-разметку из короткой строки (заголовок, ячейка)."""
    s = re.sub(r"\*\*(.+?)\*\*", r"\1", s)
    s = re.sub(r"`([^`]*)`", r"\1", s)
    s = s.replace("**", "").strip()
    return s


@dataclass
class Heading:
    offset: int
    level: int
    title: str


class SectionIndex:
    """Путь раздела для смещения в тексте по markdown-заголовкам."""

    def __init__(self, text: str):
        self.headings: list[Heading] = []
        offset = 0
        in_fence = False
        for line in text.split("\n"):
            if _FENCE_RE.match(line):
                in_fence = not in_fence
            elif not in_fence:
                m = _HEADING_RE.match(line)
                if m:
                    self.headings.append(Heading(offset, len(m.group(1)), clean_inline(m.group(2))))
            offset += len(line) + 1
        self._offsets = [h.offset for h in self.headings]
        h1 = [h for h in self.headings if h.level == 1]
        # единственный заголовок первого уровня — название документа, в путь не включаем
        self._skip_title = len(h1) == 1 and bool(self.headings) and self.headings[0].level == 1

    def chain(self, offset: int) -> list[Heading]:
        i = bisect_right(self._offsets, offset)
        stack: list[Heading] = []
        for h in self.headings[:i]:
            while stack and stack[-1].level >= h.level:
                stack.pop()
            stack.append(h)
        if self._skip_title and stack and stack[0].level == 1:
            stack = stack[1:]
        return stack

    def path(self, offset: int) -> str:
        chain = self.chain(offset)
        return " › ".join(h.title for h in chain) if chain else "Документ"

    def section_span(self, offset: int) -> tuple[int, int]:
        """Границы самого глубокого раздела, содержащего смещение."""
        i = bisect_right(self._offsets, offset)
        start = self.headings[i - 1].offset if i > 0 else 0
        end = self.headings[i].offset if i < len(self.headings) else 10**12
        return start, end

    def title_at(self, offset: int) -> str:
        chain = self.chain(offset)
        return chain[-1].title if chain else ""


def page_for(offset: int | None, page_offsets: list[int] | None) -> int | None:
    if offset is None or not page_offsets:
        return None
    return max(1, bisect_right(page_offsets, offset))


def shorten(s: str, limit: int) -> str:
    s = " ".join(s.split())
    return s if len(s) <= limit else s[: limit - 1].rstrip() + "…"


def plural(n: int, one: str, few: str, many: str) -> str:
    """Число с существительным в нужной форме: 1 замечание, 2 замечания, 5 замечаний."""
    k = abs(n) % 100
    form = many if 11 <= k <= 14 else one if k % 10 == 1 else few if 2 <= k % 10 <= 4 else many
    return f"{n} {form}"
