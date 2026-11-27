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


def ancestors(folder: str) -> list[str]:
    """«a/b/c» → [«a», «a/b», «a/b/c»]."""
    parts = folder.split("/") if folder else []
    return ["/".join(parts[: i + 1]) for i in range(len(parts))]


def parent_of(folder: str) -> str:
    return folder.rsplit("/", 1)[0] if "/" in folder else ""


def within(path: str, folder: str) -> bool:
    """Путь — сама папка или вложен в неё."""
    return path == folder or path.startswith(folder + "/")


def move_path(path: str, old: str, new: str) -> str:
    """Перенос поддерева: путь внутри «old» получает префикс «new»; остальные пути не меняются."""
    if path == old:
        return new
    if path.startswith(old + "/"):
        rest = path[len(old) + 1 :]
        return f"{new}/{rest}" if new else rest
    return path


def rename_links(text: str, old_title: str, new_title: str) -> str:
    """[[Старое]], [[Старое|подпись]], [[папка/Старое]] → [[Новое…]] — после переименования заметки."""
    old = _key(old_title)

    def repl(m: re.Match[str]) -> str:
        target, sep, alias = m.group(1).partition("|")
        bare = target.strip()
        if _key(bare) != old and _key(bare.rsplit("/", 1)[-1]) != old:
            return m.group(0)
        return f"[[{new_title}{sep}{alias}]]"

    return _LINK.sub(repl, text or "")


@dataclass
class SearchHit:
    id: str
    title: str
    folder: str
    snippet: str
    score: float


_MD_NOISE = re.compile(r"\|?\s*:?-{3,}:?\s*|[#*_`>|]+")


def plain_text(text: str) -> str:
    """Текст без разметки Markdown для фрагментов поиска: [[Цель|подпись]] → подпись, без #, *, |, ---."""
    text = _LINK.sub(lambda m: m.group(1).split("|", 1)[-1].strip(), text or "")
    return " ".join(_MD_NOISE.sub(" ", text).split())


def _snippet(text: str, pos: int, width: int = 160) -> str:
    start = max(0, pos - width // 3)
    end = min(len(text), start + width)
    s = " ".join(text[start:end].split())
    return ("…" if start > 0 else "") + s + ("…" if end < len(text) else "")


def search_notes(notes: Iterable["Note"], query: str, limit: int = 20) -> list[SearchHit]:
    """Полнотекстовый поиск по названию, папке и тексту: все слова запроса должны встретиться.
    Совпадение в названии весит больше; фрагмент — вокруг первого найденного слова в тексте."""
    words = _key(query).split()
    if not words:
        return []
    hits: list[SearchHit] = []
    for n in notes:
        title, body = _key(n.title), (n.content or "").lower().replace("ё", "е")
        hay = f"{title} {_key(n.folder)} {body}"
        if not all(w in hay for w in words):
            continue
        score = sum(3.0 if w in title else 0.0 for w in words) + sum(min(5, body.count(w)) * 0.2 for w in words)
        plain = plain_text(n.content)
        low = plain.lower().replace("ё", "е")
        positions = [p for p in (low.find(w) for w in words) if p >= 0]
        snippet = _snippet(plain, min(positions) if positions else 0)
        hits.append(SearchHit(n.id, n.title, n.folder, snippet, round(score, 2)))
    hits.sort(key=lambda h: (-h.score, h.title.lower()))
    return hits[:limit]


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


def all_folders(notes: Iterable[Note], explicit: Iterable[str] = ()) -> list[str]:
    """Все папки вики: явно созданные и те, где лежат заметки, вместе с родителями."""
    out: set[str] = set()
    for f in [*(n.folder for n in notes), *explicit]:
        out.update(ancestors(f))
    return sorted(out)


def build_graph(notes: Iterable[Note], explicit_folders: Iterable[str] = ()) -> dict:
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

    for f in all_folders(notes, explicit_folders):
        size = sum(1 for n in notes if within(n.folder, f))
        nodes.append({"id": f"folder:{f}", "kind": "folder", "title": f.rsplit("/", 1)[-1], "folder": f, "size": size})
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
