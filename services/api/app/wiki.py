"""База знаний как вики: папки, ссылки [[Заметка]] между заметками, упоминания критериев и граф связей.

Чистые функции без БД — их используют роутер и тесты.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass

from req_contracts import CRITERIA, Criterion

FOLDER_MAX = 500
BUILTIN_FOLDER = "Стандарты"

_LINK = re.compile(r"\[\[([^\[\]\n]{1,300})\]\]")


def normalize_folder(raw: str | None) -> str:
    """«/Стандарты//ISO 29148/ » → «Стандарты/ISO 29148». Пустая строка — корень."""
    parts = [p.strip() for p in (raw or "").replace("\\", "/").split("/")]
    parts = [p for p in parts if p and p not in (".", "..")]
    return "/".join(parts)[:FOLDER_MAX]


def _key(title: str) -> str:
    return " ".join(title.lower().replace("ё", "е").split())


def extract_links(text: str) -> list[str]:
    """Цели ссылок [[Заметка]], [[Заметка|подпись]], [[папка/Заметка]] — по порядку, без повторов.
    Цель возвращается как написана (с папкой): в названии самой заметки тоже может быть «/» (ISO/IEC/IEEE)."""
    out: dict[str, None] = {}
    for m in _LINK.finditer(text or ""):
        target = m.group(1).split("|", 1)[0].strip()
        if target:
            out.setdefault(target, None)
    return list(out)


# критерий → как найти его упоминание в тексте: код (`set_consistent`) и основа русского названия
_STEMS: dict[Criterion, list[str]] = {
    Criterion.NECESSARY: ["необходим"],
    Criterion.IMPLEMENTATION_FREE: ["без проектных решений", "проектное решение", "проектные решения"],
    Criterion.UNAMBIGUOUS: ["однозначн"],
    Criterion.COMPLETE: ["полнот"],
    Criterion.SINGULAR: ["атомарн"],
    Criterion.FEASIBLE: ["реализуем"],
    Criterion.VERIFIABLE: ["проверяем"],
    Criterion.CORRECT: ["корректн"],
    Criterion.CONFORMING: ["соответствие шаблону", "соответствия шаблону"],
    Criterion.TRACEABLE: ["трассируем", "прослеживаем"],
    Criterion.SET_COMPLETE: ["полнота набора"],
    Criterion.SET_CONSISTENT: ["непротиворечив", "противоречи"],
    Criterion.SET_FEASIBLE: ["реализуемость набора"],
    Criterion.SET_COMPREHENSIBLE: ["понятност"],
    Criterion.SET_VALIDATABLE: ["валидируем"],
    Criterion.SET_RANKED: ["ранжирован", "приоритет"],
    Criterion.SET_MODIFIABLE: ["модифицируем"],
    Criterion.SET_TRACEABLE: ["трассируемость набора"],
}
_CRITERION_PATTERNS: dict[Criterion, list[str]] = {c: [c.value, *_STEMS.get(c, [])] for c in CRITERIA}


def criteria_mentions(text: str) -> list[Criterion]:
    low = (text or "").lower().replace("ё", "е")
    return [c for c, pats in _CRITERION_PATTERNS.items() if any(p in low for p in pats)]


@dataclass
class Note:
    id: str
    title: str
    folder: str
    source: str
    content: str


def resolve_links(notes: Iterable[Note]) -> dict[str, list[tuple[str, str | None]]]:
    """Для каждой заметки — её ссылки: (подпись цели, id найденной заметки или None)."""
    notes = list(notes)
    by_title = {_key(n.title): n.id for n in notes}

    def find(target: str) -> str | None:
        # сначала полное название, затем без пути папки: [[Банк/Глоссарий]] → «Глоссарий»
        return by_title.get(_key(target)) or by_title.get(_key(target.rsplit("/", 1)[-1]))

    return {n.id: [(t, find(t)) for t in extract_links(n.content)] for n in notes}


def build_graph(notes: Iterable[Note]) -> dict:
    """Узлы: заметки, папки и упомянутые критерии; рёбра: заметка→заметка (ссылка), заметка→критерий,
    заметка→папка (вложенность), папка→родительская папка."""
    notes = list(notes)
    links = resolve_links(notes)
    nodes: list[dict] = []
    edges: list[dict] = []
    seen_edges: set[tuple[str, str, str]] = set()

    def edge(src: str, dst: str, kind: str) -> None:
        if src != dst and (src, dst, kind) not in seen_edges:
            seen_edges.add((src, dst, kind))
            edges.append({"source": src, "target": dst, "kind": kind})

    folders: set[str] = set()
    for n in notes:
        if n.folder:
            parts = n.folder.split("/")
            for i in range(1, len(parts) + 1):
                folders.add("/".join(parts[:i]))
    for f in sorted(folders):
        nodes.append({"id": f"folder:{f}", "kind": "folder", "title": f.rsplit("/", 1)[-1], "folder": f, "size": 0})
        if "/" in f:
            edge(f"folder:{f}", f"folder:{f.rsplit('/', 1)[0]}", "folder")

    used_criteria: dict[Criterion, int] = {}
    for n in notes:
        nodes.append({"id": n.id, "kind": "note", "title": n.title, "folder": n.folder, "source": n.source,
                      "size": len(n.content)})
        if n.folder:
            edge(n.id, f"folder:{n.folder}", "folder")
        for _, target in links[n.id]:
            if target:
                edge(n.id, target, "link")
        for c in criteria_mentions(n.content):
            used_criteria[c] = used_criteria.get(c, 0) + 1
            edge(n.id, f"criterion:{c.value}", "criterion")
    for c, count in used_criteria.items():
        nodes.append({"id": f"criterion:{c.value}", "kind": "criterion", "title": CRITERIA[c].title_ru,
                      "folder": "", "size": count})
    return {"nodes": nodes, "edges": edges}
