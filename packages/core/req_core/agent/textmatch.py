"""Привязка цитат к тексту документа.

Главная защита от галлюцинаций: замечание попадает в отчёт только если его цитата
действительно находится в документе. Сравнение идёт по нормализованному тексту
(регистр, пробелы, разметка markdown, типографские кавычки/тире), допускается
небольшое расхождение (модель могла слегка исказить цитату).
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from difflib import SequenceMatcher

from .ingest import Document

_MARKUP = re.compile(r"[*_`#>|]+")
_WS = re.compile(r"\s+")
_TRANS = str.maketrans(
    {
        "ё": "е", "«": '"', "»": '"', "“": '"', "”": '"', "„": '"', "’": "'", "‘": "'",
        "–": "-", "—": "-", "−": "-", "‑": "-", " ": " ", " ": " ", "…": "...",
    }
)


def normalize(s: str) -> str:
    s = s.lower().translate(_TRANS)
    s = _MARKUP.sub(" ", s)
    return _WS.sub(" ", s).strip()


@dataclass
class Match:
    start: int      # первая строка
    end: int        # последняя строка
    score: float    # 1.0 — дословное совпадение
    text: str       # фактический текст документа в этом месте


class QuoteIndex:
    """Нормализованный текст документа + отображение позиции символа в номер строки."""

    def __init__(self, doc: Document):
        self.doc = doc
        chunks: list[str] = []
        self.line_at: list[int] = []
        for ln in doc.lines:
            n = normalize(ln.text)
            if not n:
                continue
            piece = n + " "
            chunks.append(piece)
            self.line_at.extend([ln.no] * len(piece))
        self.text = "".join(chunks)

    def _span(self, pos: int, length: int) -> tuple[int, int]:
        pos = max(0, min(pos, len(self.line_at) - 1))
        last = max(0, min(pos + max(length, 1) - 1, len(self.line_at) - 1))
        return self.line_at[pos], self.line_at[last]

    def _make(self, pos: int, length: int, score: float) -> Match:
        a, b = self._span(pos, length)
        return Match(a, b, score, self.doc.span_text(a, b))

    def find(self, quote: str, near: int | None = None, min_score: float = 0.82) -> Match | None:
        """Ищет цитату. near — ожидаемая строка: из нескольких вхождений берётся ближайшее."""
        if not quote or not self.text:
            return None
        # цитата с пропуском «…» — ищем самую длинную часть
        parts = [p for p in re.split(r"\.\.\.|\[\.\.\.\]", quote.translate(_TRANS)) if len(normalize(p)) >= 8]
        if len(parts) > 1:
            quote = max(parts, key=len)
        q = normalize(quote)
        if len(q) < 4:
            return None

        # 1) точное вхождение
        hits = [m.start() for m in re.finditer(re.escape(q), self.text)]
        if hits:
            pos = min(hits, key=lambda p: abs(self.line_at[p] - near)) if near else hits[0]
            return self._make(pos, len(q), 1.0)

        # 2) нечёткий поиск: якоримся по шинглам из слов, сравниваем окно
        words = q.split()
        n = 3 if len(words) >= 6 else 2 if len(words) >= 2 else 1
        candidates: set[int] = set()
        offset = 0
        for i in range(0, max(1, len(words) - n + 1)):
            shingle = " ".join(words[i : i + n])
            start = 0
            while len(candidates) < 400:
                p = self.text.find(shingle, start)
                if p == -1:
                    break
                candidates.add(max(0, p - offset))
                start = p + 1
            offset += len(words[i]) + 1
        best: tuple[float, int] | None = None
        for c in candidates:
            window = self.text[c : c + len(q) + 12]
            score = SequenceMatcher(None, q, window[: len(q) + 6], autojunk=False).ratio()
            if near:
                score -= min(abs(self.line_at[min(c, len(self.line_at) - 1)] - near), 50) * 0.0004
            if best is None or score > best[0]:
                best = (score, c)
        if best and best[0] >= min_score:
            return self._make(best[1], len(q), round(min(best[0], 0.99), 3))
        return None
