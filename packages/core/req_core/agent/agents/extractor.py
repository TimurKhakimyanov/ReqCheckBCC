"""Нарезчик: выделяет отдельные требования и присваивает им идентификаторы отчёта.

Два прохода:
  1) модель выделяет требования из всех разделов;
  2) контроль покрытия: строки, не вошедшие ни в одно требование, отдаются модели
     повторно — она либо находит пропущенное требование, либо объясняет, почему строка
     требованием не является. Так нарезка не «теряет» текст молча.
"""
from __future__ import annotations

import re

from .. import prompts
from ..budget import ContextOverflow
from ..criteria import REQ_TYPES
from ..rules import find_checklist
from ..textmatch import normalize
from .common import Ctx, clean, lst, render_fit, s, split_doc, to_int

CHUNK_CHARS = 45_000     # больший документ режется на части по заголовкам
_SEPARATOR = re.compile(r"^\s*(\|?\s*:?-{2,}:?\s*)+\|?\s*$|^\s*([-*_]\s*){3,}$|^\s*```")


def _chunks(ctx: Ctx) -> list[tuple[int, int]]:
    """Части документа для нарезки: не больше CHUNK_CHARS и не больше доли окна модели под документ."""
    system, user0 = prompts.load("extractor").render(document="", range="")
    return split_doc(ctx, max(500, min(CHUNK_CHARS, ctx.room(system, user0))))


def _template_lines(ctx: Ctx) -> set[int]:
    """Строки шаблонного чек-листа ревью («Да / Нет»): это не требования к системе."""
    return {no for no, _ in find_checklist(ctx.doc)}


def _normalize(ctx: Ctx, raw: dict) -> dict | None:
    """Приводит ответ модели к требованию с проверенными строками и дословным текстом."""
    if not isinstance(raw, dict):
        return None
    n = len(ctx.doc.lines)
    ls, le = to_int(raw.get("line_start")), to_int(raw.get("line_end"))
    quote = s(raw.get("quote"))
    lines_ok = ls is not None and 1 <= ls <= n
    if lines_ok:
        le = le if (le is not None and ls <= le <= n and le - ls <= 80) else ls
    m = ctx.index.find(quote, near=ls if lines_ok else None) if quote else None
    if m and lines_ok and ls - 1 <= m.start <= le + 1:
        start, end = min(ls, m.start), max(le, m.end)
    elif m:
        start, end = m.start, m.end        # номера строк от модели не сошлись с цитатой — верим тексту
    elif lines_ok:
        start, end = ls, le
    else:
        return None
    # обрезаем пустые строки и разделители по краям
    while start < end and (not ctx.doc.line(start).text.strip() or _SEPARATOR.match(ctx.doc.line(start).text)):
        start += 1
    while end > start and (not ctx.doc.line(end).text.strip() or _SEPARATOR.match(ctx.doc.line(end).text)):
        end -= 1
    text = _span_text(ctx, start, end)
    if len(text) < 3:
        return None
    doc_id = s(raw.get("doc_id")) or None
    if doc_id and normalize(doc_id) not in normalize(text):
        doc_id = None
    rtype = s(raw.get("type")).lower()
    return {
        "doc_id": doc_id,
        "line_start": start,
        "line_end": end,
        "text": text,
        "quote": clean(text, 300),
        "summary": clean(s(raw.get("summary")) or text, 160),
        "type": rtype if rtype in REQ_TYPES else "functional",
    }


def _span_text(ctx: Ctx, start: int, end: int) -> str:
    """Текст требования без ограждений кода, разделителей таблиц и решёток заголовков."""
    parts = []
    for n in range(start, end + 1):
        t = ctx.doc.line(n).text.strip()
        if not t or _SEPARATOR.match(t):
            continue
        parts.append(clean(re.sub(r"^#+\s*", "", t)))
    return " ".join(p for p in parts if p)


def _dedupe(ctx: Ctx, items: list[dict]) -> list[dict]:
    """Убирает повторы и вложенные требования; пересекающиеся обрезает по началу следующего."""
    items = sorted(items, key=lambda r: (r["line_start"], -(r["line_end"] - r["line_start"])))
    out: list[dict] = []
    for r in items:
        if any(k["line_start"] == r["line_start"] and k["line_end"] == r["line_end"] for k in out):
            continue
        # одно требование целиком внутри другого: оставляем более мелкую нарезку
        outer = next((k for k in out if k["line_start"] <= r["line_start"] and r["line_end"] <= k["line_end"]), None)
        if outer is not None:
            if r["line_start"] == outer["line_start"]:
                continue
            outer["line_end"] = r["line_start"] - 1
        out.append(r)
    out.sort(key=lambda r: r["line_start"])
    for cur, nxt in zip(out, out[1:]):
        if cur["line_end"] >= nxt["line_start"]:
            cur["line_end"] = nxt["line_start"] - 1
    res = []
    for r in out:
        a, b = r["line_start"], r["line_end"]
        while b > a and (not ctx.doc.line(b).text.strip() or ctx.doc.line(b).is_heading or _SEPARATOR.match(ctx.doc.line(b).text)):
            b -= 1
        if b < a:
            continue
        r["line_end"] = b
        r["text"] = _span_text(ctx, a, b)
        r["quote"] = clean(r["text"], 300)
        if len(r["text"]) >= 3:
            res.append(r)
    return res


def _uncovered(ctx: Ctx, reqs: list[dict]) -> list[tuple[int, int]]:
    covered = set()
    for r in reqs:
        covered.update(range(r["line_start"], r["line_end"] + 1))
    ranges: list[tuple[int, int]] = []
    cur: list[int] = []
    for ln in ctx.doc.lines:
        content = bool(ln.text.strip()) and not ln.is_heading and not _SEPARATOR.match(ln.text)
        if content and ln.no not in covered:
            cur.append(ln.no)
        elif (content or ln.is_heading) and cur:
            ranges.append((cur[0], cur[-1]))
            cur = []
    if cur:
        ranges.append((cur[0], cur[-1]))
    return ranges


def _extract_part(ctx: Ctx, a: int, b: int, depth: int = 0) -> list[dict]:
    """Нарезка одной части документа. Если часть не помещается в окно модели — делится пополам."""
    p = prompts.load("extractor")
    system, user = p.render(document=ctx.doc.numbered(a, b), range=f"{a}–{b}")
    try:
        data = ctx.llm.json("extractor", system, user, label=f"нарезка L{a}–L{b}", prompt="extractor")
    except ContextOverflow:
        if b <= a or depth > 6:
            raise
        mid = (a + b) // 2
        return _extract_part(ctx, a, mid, depth + 1) + _extract_part(ctx, mid + 1, b, depth + 1)
    return [r for r in (_normalize(ctx, raw) for raw in lst(data.get("requirements") if isinstance(data, dict) else data)) if r]


def _gap_batches(ctx: Ctx, gaps: list[tuple[int, int]]) -> list[list[tuple[int, int]]]:
    """Непокрытые строки одним запросом, если документ помещается; иначе — пачками."""
    system, user0 = prompts.load("extractor_gaps").render(document="", requirements="", uncovered="")
    limit = max(300, ctx.room(system, user0) // 4)
    out, cur, size = [], [], 0
    for a, b in gaps:
        n = sum(len(ctx.doc.line(i).text) + 10 for i in range(a, b + 1))
        if cur and size + n > limit:
            out.append(cur)
            cur, size = [], 0
        cur.append((a, b))
        size += n
    if cur:
        out.append(cur)
    return out


def run(ctx: Ctx) -> None:
    doc = ctx.doc
    template = _template_lines(ctx)
    found: list[dict] = []
    parts = _chunks(ctx)
    for a, b in parts:
        found += _extract_part(ctx, a, b)

    def real(r: dict) -> bool:    # требование, целиком состоящее из строк шаблонного чек-листа, не принимаем
        return not all(n in template for n in range(r["line_start"], r["line_end"] + 1))

    reqs = _dedupe(ctx, [r for r in found if real(r)])
    first_pass = len(reqs)

    # Контроль покрытия нарезки.
    skipped: list[dict] = []
    gaps = [g for g in _uncovered(ctx, reqs) if not all(n in template for n in range(g[0], g[1] + 1))]
    pg = prompts.load("extractor_gaps")
    explained: set[int] = set()
    for batch in _gap_batches(ctx, gaps) if gaps else []:
        lo, hi = batch[0][0], batch[-1][1]
        listing = "\n".join(f"{r['line_start']}–{r['line_end']}: {r['summary']}" for r in reqs) or "(нет)"
        if len(listing) > ctx.room() // 4:     # список требований велик: оставляем только соседние с непокрытыми строками
            near = [r for r in reqs if lo - 40 <= r["line_start"] <= hi + 40]
            listing = ("\n".join(f"{r['line_start']}–{r['line_end']}: {r['summary']}" for r in near) or "(нет)")[: ctx.room() // 4]
        unc = "\n".join(
            f"L{a}–L{b}:\n" + "\n".join(f"  L{n}| {doc.line(n).text.strip()}" for n in range(a, b + 1) if doc.line(n).text.strip())
            for a, b in batch
        )
        system, user = render_fit(ctx, pg, batch, pad=4, requirements=listing, uncovered=unc)
        try:
            data = ctx.llm.json("extractor", system, user, label=f"контроль покрытия нарезки L{lo}–L{hi}",
                                prompt="extractor_gaps")
        except ContextOverflow:
            continue
        gap_lines = {n for a, b in batch for n in range(a, b + 1)}
        extra = []
        for raw in lst(data.get("requirements")) if isinstance(data, dict) else []:
            r = _normalize(ctx, raw)
            if r and r["line_start"] in gap_lines and real(r):
                extra.append(r)
        reqs = _dedupe(ctx, reqs + extra)
        for sk in lst(data.get("skipped")) if isinstance(data, dict) else []:
            if not isinstance(sk, dict):
                continue
            a, b = to_int(sk.get("line_start")), to_int(sk.get("line_end"))
            if a is None or not (1 <= a <= len(doc.lines)):
                continue
            b = b if (b is not None and a <= b <= len(doc.lines)) else a
            skipped.append({"line_start": a, "line_end": b, "reason": s(sk.get("reason"), "не требование")})
            explained.update(range(a, b + 1))
    # Кандидаты детерминированных правил ReqCheck (пронумерованные пункты, строки таблиц требований и критериев
    # приёмки), которые модель не взяла и не объяснила как «не требование», — добавляются: так нарезка не теряет
    # требования, если модель пропустила часть документа или не ответила.
    by_rules = 0
    for cand in ctx.meta.get("rule_candidates", []):
        lines = range(cand["line_start"], cand["line_end"] + 1)
        if any(n in explained or n in template for n in lines):
            continue
        covered_now = {n for r in reqs for n in range(r["line_start"], r["line_end"] + 1)}
        if any(n in covered_now for n in lines):
            continue
        r = _normalize(ctx, cand)
        if r and real(r):
            reqs = _dedupe(ctx, reqs + [r])
            by_rules += 1
    for a, b in _uncovered(ctx, reqs):
        lines = [n for n in range(a, b + 1) if doc.line(n).text.strip()]
        if all(n in template for n in lines):
            skipped.append({"line_start": a, "line_end": b, "reason": "шаблонный чек-лист ревью: оценивается на уровне набора"})
        elif not all(n in explained for n in lines):
            if not any(k["line_start"] <= a and b <= k["line_end"] for k in skipped):
                skipped.append({"line_start": a, "line_end": b, "reason": "служебный текст (агент не классифицировал)"})
    ctx.meta.setdefault("context_mode", {}).update({"extract_parts": len(parts), "doc_tokens_est": ctx.budget.estimate(ctx.doc_text)})

    reqs.sort(key=lambda r: r["line_start"])
    for r in reqs:
        rid = ctx.graph.new_id(ctx.graph.prefix["req"])
        line = doc.line(r["line_start"])
        ctx.graph.add(
            "requirement", rid, "open",
            **r, section=line.section if line else "", where=doc.where(r["line_start"], r["line_end"]),
            verdicts={},
        )
        ctx.graph.link(rid, "DOC", "part_of")
    covered_req = {n for r in reqs for n in range(r["line_start"], r["line_end"] + 1)}
    for sk in skipped:
        sk["text"] = clean(doc.span_text(sk["line_start"], sk["line_end"]), 160)
    ctx.meta["skipped"] = sorted(
        [k for k in skipped if not all(n in covered_req for n in range(k["line_start"], k["line_end"] + 1))],
        key=lambda k: k["line_start"],
    )
    ctx.meta["extraction"] = {"first_pass": first_pass, "added_by_coverage": len(reqs) - first_pass - by_rules,
                              "added_by_rules": by_rules, "total": len(reqs)}
    ctx.say(f"   выделено требований: {len(reqs)} (контроль покрытия добавил {max(0, len(reqs) - first_pass)})")
