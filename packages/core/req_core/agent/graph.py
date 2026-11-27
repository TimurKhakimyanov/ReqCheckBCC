"""Общая память агентов — типизированный граф.

Агенты не передают ответы друг другу напрямую: каждый читает и пишет граф.
Отчёт собирается обходом графа, а не из «текста в логе».

Узлы (kind):
  document     проверяемый документ
  requirement  выделенное требование
  criterion    критерий качества (ISO 29148 / IEEE 830)
  intent       единица работы (задание воркеру) — очередь планировщика
  hint         подсказка детерминированного правила
  finding      замечание (confirmed / dismissed / merged)
  question     уточняющий вопрос автору ТЗ
  answer       ответ человека на вопрос

Рёбра (rel):
  part_of      requirement -> document
  covers       intent -> requirement        (учёт покрытия)
  yields       intent -> finding            (кто нашёл)
  about        finding -> requirement       (к чему относится)
  violates     finding -> criterion
  derived_from finding -> hint | finding    (из чего выведено / чей дубль)
  conflicts    requirement -> requirement   (противоречие)
  clarifies    question -> finding
  answers      answer -> question
"""
from __future__ import annotations

import re
import threading
import time
from dataclasses import asdict, dataclass, field
from typing import Any, Iterable


@dataclass
class Node:
    id: str
    kind: str
    state: str = "open"
    payload: dict[str, Any] = field(default_factory=dict)


@dataclass
class Edge:
    src: str
    dst: str
    rel: str


DEFAULT_PREFIX = {"req": "R", "finding": "D", "question": "Q"}
_PREFIX_CANDIDATES = {"req": ("R", "REQ", "TR"), "finding": ("D", "F", "DEF"), "question": ("Q", "QST", "VQ")}


def pick_prefixes(text: str) -> dict[str, str]:
    """Префиксы идентификаторов отчёта, которых нет в самом документе.

    Если документ сам нумерует пункты как R-001 или F-001, совпадение с идентификаторами отчёта
    путает и модель, и читателя («R-007» в итоге — это требование документа или отчёта?).
    """
    used: set[str] = set()
    out: dict[str, str] = {}
    for kind, cands in _PREFIX_CANDIDATES.items():
        for p in cands:
            if p not in used and not re.search(rf"(?<![\w-]){re.escape(p)}-\d", text):
                out[kind] = p
                break
        else:
            out[kind] = cands[-1] + "X"
        used.add(out[kind])
    return out


class Graph:
    def __init__(self) -> None:
        self.prefix: dict[str, str] = dict(DEFAULT_PREFIX)   # префиксы идентификаторов отчёта
        self.nodes: dict[str, Node] = {}
        self.edges: list[Edge] = []
        self.activity: list[dict] = []      # append-only трейс: что делал каждый агент
        self.stage = ""                     # текущий этап прогона — проставляется в каждую запись трейса
        self.sink = None                    # функция, которая сразу пишет запись на диск
        self._lock = threading.Lock()
        self._seq: dict[str, int] = {}
        self._t0 = time.time()

    # --- запись
    def new_id(self, prefix: str, width: int = 3) -> str:
        with self._lock:
            n = self._seq.get(prefix, 0) + 1
            self._seq[prefix] = n
        return f"{prefix}-{n:0{width}d}"

    def add(self, kind: str, id: str, state: str = "open", **payload: Any) -> Node:
        node = Node(id=id, kind=kind, state=state, payload=payload)
        with self._lock:
            self.nodes[id] = node
        return node

    def link(self, src: str, dst: str, rel: str) -> None:
        with self._lock:
            if not any(e.src == src and e.dst == dst and e.rel == rel for e in self.edges):
                self.edges.append(Edge(src, dst, rel))

    def rename(self, mapping: dict[str, str]) -> None:
        """Переименовывает узлы (вместе с рёбрами), сохраняя порядок, заданный mapping."""
        with self._lock:
            renamed = {}
            for old, new in mapping.items():
                node = self.nodes.pop(old)
                node.id = new
                renamed[new] = node
            self.nodes.update(renamed)
            for e in self.edges:
                e.src = mapping.get(e.src, e.src)
                e.dst = mapping.get(e.dst, e.dst)

    def log(self, rec: dict) -> None:
        rec = {"t": round(time.time() - self._t0, 2), "stage": self.stage, **rec}
        with self._lock:
            self.activity.append(rec)
            if self.sink:
                self.sink(rec)

    # --- чтение
    def get(self, id: str) -> Node | None:
        return self.nodes.get(id)

    def of(self, kind: str, state: str | Iterable[str] | None = None) -> list[Node]:
        states = None if state is None else ({state} if isinstance(state, str) else set(state))
        return [n for n in self.nodes.values() if n.kind == kind and (states is None or n.state in states)]

    def out(self, src: str, rel: str) -> list[Node]:
        return [self.nodes[e.dst] for e in self.edges if e.src == src and e.rel == rel and e.dst in self.nodes]

    def into(self, dst: str, rel: str) -> list[Node]:
        return [self.nodes[e.src] for e in self.edges if e.dst == dst and e.rel == rel and e.src in self.nodes]

    def stats(self) -> dict[str, int]:
        out: dict[str, int] = {}
        for n in self.nodes.values():
            out[n.kind] = out.get(n.kind, 0) + 1
        out["edges"] = len(self.edges)
        return out

    def to_json(self) -> dict:
        return {
            "nodes": [asdict(n) for n in self.nodes.values()],
            "edges": [asdict(e) for e in self.edges],
            "stats": self.stats(),
        }
