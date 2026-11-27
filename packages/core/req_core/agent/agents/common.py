"""Общий контекст агентов и доменные операции записи в граф.

record-функции здесь — «доменные инструменты» агентов: они превращают свободный вывод модели в типизированные узлы
графа и не пускают в него то, что не привязано к тексту документа.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Callable

from .. import guard
from ..config import AgentConfig as Config
from ..criteria import BY_CODE, DEFECT_TYPES, SEVERITY
from ..graph import Graph, Node
from ..ingest import Document
from ..llm import AgentLLM as LLMClient
from ..textmatch import QuoteIndex, normalize

ADDRESSEES = ("Business owner", "Product owner", "Аналитик", "Архитектор", "Разработчик", "Тестировщик", "ИБ")


@dataclass
class Ctx:
    cfg: Config
    llm: LLMClient
    graph: Graph
    doc: Document
    index: QuoteIndex
    say: Callable[[str], None]
    meta: dict[str, Any] = field(default_factory=dict)   # результаты, не являющиеся узлами графа
    tick: Callable[[int, int, str], None] = lambda done, total, title: None   # ход работы для прогресса

    @property
    def doc_text(self) -> str:
        if "_doc_text" not in self.meta:
            self.meta["_doc_text"] = self.doc.numbered()
        return self.meta["_doc_text"]

    # --- контроль контекста -------------------------------------------------
    @property
    def budget(self):
        return self.llm.budget

    def room(self, *fixed: str, reserve: int = 300) -> int:
        """Сколько символов документа ещё помещается в запрос, если остальные его части уже известны."""
        return max(0, self.budget.chars_for(self.budget.input_limit) - sum(len(x) for x in fixed) - reserve)

    def doc_context(self, spans: list[tuple[int, int]], pad: int = 12, max_chars: int | None = None) -> str:
        """Текст документа для промта: целиком, если помещается в max_chars, иначе выдержки вокруг нужных строк.

        Так агент, которому нужно несколько мест большого документа, не тащит в запрос весь документ.
        """
        limit = self.budget.chars_for(self.budget.doc_limit) if max_chars is None else max_chars
        if len(self.doc_text) <= limit:
            return self.doc_text
        n = len(self.doc.lines)
        spans = sorted({(max(1, a), min(n, b)) for a, b in spans if a and b}) or [(1, min(n, 40))]
        for p in (pad, pad // 2, 3, 1, 0):
            text = self._excerpt(spans, p)
            if len(text) <= limit:
                return text
        # даже без полей не помещается: оставляем столько мест, сколько влезает
        kept: list[tuple[int, int]] = []
        for sp in spans:
            if len(self._excerpt(kept + [sp], 0)) > limit:
                break
            kept.append(sp)
        return self._excerpt(kept or spans[:1], 0)[:limit]

    def _excerpt(self, spans: list[tuple[int, int]], pad: int) -> str:
        n = len(self.doc.lines)
        windows: list[list[int]] = []
        for a, b in spans:
            a, b = max(1, a - pad), min(n, b + pad)
            if windows and a <= windows[-1][1] + 1:
                windows[-1][1] = max(windows[-1][1], b)
            else:
                windows.append([a, b])
        out = ["[Документ велик: показаны только нужные фрагменты. Пропуски отмечены.]"]
        prev_end = 0
        for a, b in windows:
            if a > prev_end + 1:
                out.append(f"[… {self.doc.place(prev_end + 1, a - 1)} пропущены …]")
            sec = self.doc.line(a).section if self.doc.line(a) else ""
            if sec:
                out.append(f"[раздел: {sec}]")
            out.append(self.doc.numbered(a, b))
            prev_end = b
        if prev_end < n:
            out.append(f"[… {self.doc.place(prev_end + 1, n)} пропущены …]")
        return "\n".join(x for x in out if x)


def render_fit(ctx: "Ctx", prompt, spans: list[tuple[int, int]], pad: int = 12, cap: int | None = None, **vars) -> tuple[str, str]:
    """Собирает запрос так, чтобы он поместился в окно модели.

    Сначала измеряются все части запроса, кроме документа (инструкции, списки требований и замечаний),
    затем документу отдаётся оставшееся место: целиком, если помещается, иначе — выдержки вокруг spans.
    """
    system, user0 = prompt.render(document="", **vars)
    room = ctx.room(system, user0)
    if cap is not None:
        room = min(room, cap)
    return prompt.render(document=ctx.doc_context(spans, pad, max_chars=room), **vars)


def split_doc(ctx: "Ctx", max_chars: int) -> list[tuple[int, int]]:
    """Делит документ на части не больше max_chars, по возможности по границам разделов."""
    doc = ctx.doc
    if len(ctx.doc_text) <= max_chars:
        return [(1, len(doc.lines))]
    out: list[tuple[int, int]] = []
    start, size = 1, 0
    for ln in doc.lines:
        add = len(ln.text) + 8
        at_heading = ln.is_heading and size > max_chars * 0.6
        if ln.no > start and (at_heading or size + add > max_chars):
            out.append((start, ln.no - 1))
            start, size = ln.no, 0
        size += add
    out.append((start, len(doc.lines)))
    return out


# ----------------------------------------------------------------------------- приведение типов
def s(v: Any, default: str = "") -> str:
    if v is None:
        return default
    if isinstance(v, (list, dict)):
        return default
    t = str(v).strip()
    return default if t.lower() in ("null", "none", "") else t


def lst(v: Any) -> list:
    if isinstance(v, list):
        return v
    if v is None:
        return []
    return [v]


def to_int(v: Any) -> int | None:
    if isinstance(v, bool):
        return None
    if isinstance(v, int):
        return v
    if isinstance(v, float):
        return int(v)
    if isinstance(v, str):
        m = re.search(r"\d+", v)
        return int(m.group(0)) if m else None
    return None


_MD = re.compile(r"(\*\*|__|`)")
# Маркер пункта списка. Номер — не более двух цифр: «200.» и «401.» в описании API — это коды ответов,
# а не номера пунктов, их удалять нельзя.
_BULLET = re.compile(r"^\s*([*\-•]|\d{1,2}[.)])\s+")
_PREFIX = re.compile(r"\bL\d+\|\s?")


def clean(text: str, limit: int | None = None) -> str:
    """Текст документа для показа в отчёте: без разметки markdown и служебных префиксов."""
    t = _PREFIX.sub("", text or "")
    t = _MD.sub("", t)
    t = _BULLET.sub("", t.strip())
    t = re.sub(r"\s*\|\s*", " | ", t).strip(" |")
    t = re.sub(r"\s+", " ", t).strip()
    if limit and len(t) > limit:
        t = t[: limit - 1].rstrip() + "…"
    return t


# ----------------------------------------------------------------------------- привязка к тексту
def anchor(ctx: Ctx, quote: str, line: int | None = None, span: tuple[int, int] | None = None) -> dict | None:
    """Привязывает цитату к документу. Возвращает место и дословный текст либо None.

    span — допустимый диапазон строк (для замечаний к конкретному требованию).
    """
    quote = _PREFIX.sub("", s(quote))
    near = line or (span[0] if span else None)
    m = ctx.index.find(quote, near=near) if quote else None
    if m and span and not (span[0] - 1 <= m.start <= span[1] + 1):
        # цитата нашлась, но в другом месте документа — пробуем найти внутри требования
        inner = None
        for hit_near in range(span[0], span[1] + 1):
            cand = ctx.index.find(quote, near=hit_near)
            if cand and span[0] - 1 <= cand.start <= span[1] + 1:
                inner = cand
                break
        m = inner
    if m:
        text = clean(quote, 400) if m.score >= 0.999 else clean(m.text, 400)
        return {"line_start": m.start, "line_end": m.end, "quote": text, "where": ctx.doc.where(m.start, m.end), "score": m.score}

    # Цитата искажена, но агент указал строку: принимаем, если слова цитаты действительно из этой строки.
    if line and ctx.doc.line(line) and quote:
        a, b = (line, line)
        if span and span[0] <= line <= span[1]:
            a, b = span
        target = normalize(ctx.doc.span_text(a, b))
        words = [w for w in normalize(quote).split() if len(w) > 3]
        if words and sum(1 for w in words if w in target) / len(words) >= 0.6:
            return {
                "line_start": a, "line_end": b, "quote": clean(ctx.doc.span_text(a, b), 400),
                "where": ctx.doc.where(a, b), "score": 0.6,
            }
    return None


def reqs_at(ctx: Ctx, start: int, end: int) -> list[str]:
    """Требования, чьи строки пересекаются с диапазоном."""
    out = []
    for r in ctx.graph.of("requirement"):
        if r.payload["line_start"] <= end and r.payload["line_end"] >= start:
            out.append(r.id)
    return out


# ----------------------------------------------------------------------------- доменные операции
def record_finding(
    ctx: Ctx,
    *,
    source: str,
    level: str,                     # "req" — к требованию, "set" — к набору
    raw: dict,
    req_ids: list[str],
    evidence_raw: list[dict],
    span: tuple[int, int] | None = None,
    intent: str | None = None,
    allowed_codes: list[str] | None = None,
) -> Node | None:
    """Записывает замечание-кандидат в граф. Без привязанной цитаты замечание не принимается."""
    code = s(raw.get("criterion")).upper()
    code = re.sub(r"[^IS0-9]", "", code)
    if code not in BY_CODE or (allowed_codes and code not in allowed_codes and level == "req"):
        return None
    problem = s(raw.get("problem"))
    if len(problem) < 15:
        return None

    evidence = []
    for ev in evidence_raw[:4]:
        if not isinstance(ev, dict):
            continue
        a = anchor(ctx, s(ev.get("quote")), to_int(ev.get("line")), span)
        if a and not any(e["line_start"] == a["line_start"] and e["quote"] == a["quote"] for e in evidence):
            evidence.append(a)

    severity = s(raw.get("severity")).lower()
    if severity not in SEVERITY:
        severity = "major"
    dtype = s(raw.get("defect_type")).lower()
    if dtype not in DEFECT_TYPES:
        dtype = "ambiguous" if code == "I3" else "incomplete"
    addressee = s(raw.get("addressee"))
    if addressee not in ADDRESSEES:
        addressee = "Аналитик"
    question = s(raw.get("question"))

    req_ids = [r for r in dict.fromkeys(req_ids) if ctx.graph.get(r)]
    if level == "set":
        for ev in evidence:
            for rid in reqs_at(ctx, ev["line_start"], ev["line_end"]):
                if rid not in req_ids:
                    req_ids.append(rid)

    # Контроль достоверности: несуществующие ссылки убираем, привязку к тексту оцениваем.
    problem = guard.scrub(ctx, problem, f"замечание ({source})", kinds="RQ")
    recommendation = guard.scrub(ctx, s(raw.get("recommendation")), f"рекомендация ({source})", kinds="RQ")
    question = guard.scrub(ctx, question, f"вопрос агента ({source})", kinds="RQ")
    grounding = guard.assess(ctx, {"evidence": evidence, "problem": problem})
    verify: dict = {}
    if not evidence:
        verify = {"verdict": "drop", "reason": "цитата не найдена в документе — замечание не привязано к тексту"}
    elif guard.weak(grounding):
        verify = {"verdict": "drop", "reason": "слабая привязка: цитата искажена, а в тексте замечания есть цитаты, которых нет в документе"}

    cid = ctx.graph.new_id("TMP", 4)   # временный id: воркеры параллельны, итоговые C-… назначит верификатор
    state = "dismissed" if verify else "proposed"
    node = ctx.graph.add(
        "finding", cid, state,
        source=source, level=level, criterion=code, severity=severity, defect_type=dtype,
        title=clean(s(raw.get("title")) or problem.split(". ")[0], 140),
        req_ids=req_ids, evidence=evidence, problem=problem,
        recommendation=recommendation,
        question=question, addressee=addressee if question else "",
        verify=verify, grounding=grounding,
        also=[],
    )
    ctx.graph.log({
        "kind": "finding_recorded", "source": source, "criterion": code, "state": state,
        "grounding": grounding["level"], "title": node.payload["title"],
        "reason": verify.get("reason", ""), "quotes_given": [s(e.get("quote"))[:160] for e in evidence_raw[:4] if isinstance(e, dict)],
    })
    ctx.graph.link(cid, code, "violates")
    for rid in req_ids:
        ctx.graph.link(cid, rid, "about")
    if intent:
        ctx.graph.link(intent, cid, "yields")
    return node


# ----------------------------------------------------------------------------- представления для промтов
def req_table(ctx: Ctx, span: tuple[int, int] | None = None, max_chars: int | None = None) -> str:
    """Список требований для промта. Если целиком не помещается в max_chars — подробно только
    требования из части span, остальные перечисляются одной строкой (id и строки)."""
    def row(r: Node) -> str:
        p = r.payload
        ls, le = p["line_start"], p["line_end"]
        rng = f"L{ls}" if ls == le else f"L{ls}–L{le}"
        return f"{r.id} | {p['doc_id'] or '—'} | {rng} | {p['type']} | {p['summary']}"

    reqs = sorted(ctx.graph.of("requirement"), key=lambda n: n.payload["line_start"])
    full = "\n".join(row(r) for r in reqs) or "(нет)"
    if not max_chars or len(full) <= max_chars or not span:
        return full if not max_chars else full[:max_chars]
    inside = [r for r in reqs if r.payload["line_start"] <= span[1] and r.payload["line_end"] >= span[0]]
    outside = [r for r in reqs if r not in inside]
    text = "\n".join(row(r) for r in inside)
    rest = "; ".join(f"{r.id} (L{r.payload['line_start']}): {r.payload['summary'][:60]}" for r in outside)
    room = max_chars - len(text) - 80
    if room > 200 and rest:
        text += "\nТребования из других частей документа (кратко): " + rest[:room]
    return text[:max_chars] or "(нет)"


def hints_text(ctx: Ctx, start: int | None = None, end: int | None = None, max_chars: int = 12_000) -> str:
    rows = []
    for h in ctx.graph.of("hint"):
        ln = h.payload["line"]
        if start is not None and not (start <= ln <= (end or start)):
            continue
        rows.append(f"- L{ln}: {h.payload['note']}")
    text = "\n".join(rows) or "(нет)"
    return text if len(text) <= max_chars else text[:max_chars] + "\n- … (остальные подсказки опущены)"


def spans_of(nodes: list[Node], ctx: Ctx | None = None) -> list[tuple[int, int]]:
    """Строки документа, которые нужны для работы с этими замечаниями: цитаты и сами требования."""
    out: list[tuple[int, int]] = []
    for f in nodes:
        for e in f.payload.get("evidence", []):
            out.append((e["line_start"], e["line_end"]))
        if ctx is not None:
            for rid in f.payload.get("req_ids", []):
                r = ctx.graph.get(rid)
                if r:
                    out.append((r.payload["line_start"], r.payload["line_end"]))
    return out


def findings_text(ctx: Ctx, nodes: list[Node], with_question: bool = False, id_key: str = "fid", with_flags: bool = False) -> str:
    rows = []
    for f in nodes:
        p = f.payload
        fid = p.get(id_key) or f.id
        crit = BY_CODE[p["criterion"]]
        reqs = ", ".join(p["req_ids"]) or "документ в целом"
        ev = "; ".join(f"L{e['line_start']} «{e['quote'][:220]}»" for e in p["evidence"])
        lvl = "уровень: требование" if p["level"] == "req" else "уровень: набор"
        row = (
            f"{fid} | {lvl} | {p['severity']} | {p['defect_type']} | {crit.code} «{crit.name}» | {reqs}\n"
            f"  Суть: {p['title']}. {p['problem']}\n  Цитаты (сверены с документом): {ev}"
        )
        g = p.get("grounding") or {}
        if with_flags and g.get("unverified_quotes"):
            row += "\n  ⚠ Контроль достоверности: в тексте замечания приведены цитаты, которых НЕТ в документе: " + \
                "; ".join(f"«{q[:120]}»" for q in g["unverified_quotes"][:3])
        if with_flags and g.get("level") == "line":
            row += "\n  ⚠ Контроль достоверности: исходная цитата агента не найдена дословно — показан текст указанной им строки."
        if with_question and p.get("question"):
            row += f"\n  Вопрос агента ({p.get('addressee') or 'Аналитик'}): {p['question']}"
        rows.append(row)
    return "\n".join(rows) or "(нет)"


def confirmed(ctx: Ctx) -> list[Node]:
    return sorted(ctx.graph.of("finding", "confirmed"), key=lambda n: n.payload.get("fid", n.id))
