"""Верификатор: независимая перепроверка замечаний перед отчётом.

Ступени:
  1) код: замечание без цитаты, найденной в документе, отклоняется ещё при записи (common.record_finding);
  2) модель-оппонент проверяет каждое замечание по тексту и выравнивает серьёзность;
  3) слияние дублей в два прохода: по всему списку и отдельно по замечаниям об одном месте документа;
     модель предлагает группы, код решает, что объединять и какое замечание оставить;
  4) код: пересчёт вердиктов по подтверждённым замечаниям, финальная нумерация F-001…
"""
from __future__ import annotations

import contextvars
import re
from concurrent.futures import ThreadPoolExecutor

from .. import prompts
from ..budget import ContextOverflow
from ..criteria import I_CODES, SEVERITY, SEVERITY_ORDER
from ..graph import Node
from ..llm import LLMTruncated
from .common import Ctx, findings_text, lst, render_fit, s, spans_of

BATCH = 20
DEDUP_ROWS = 140      # замечаний в одном запросе на слияние дублей


def _first_line(n: Node) -> int:
    ev = n.payload["evidence"]
    return ev[0]["line_start"] if ev else 10**9


# ----------------------------------------------------------------------------- перепроверка
def _check_batch(ctx: Ctx, batch: list[Node]) -> dict[str, dict]:
    system, user = render_fit(
        ctx, prompts.load("verifier"), spans_of(batch, ctx), pad=15,
        findings=findings_text(ctx, batch, id_key="_none", with_flags=True),
    )
    data = ctx.llm.json("verifier", system, user, label=f"{batch[0].id}…{batch[-1].id}", prompt="verifier")
    out: dict[str, dict] = {}
    for d in lst(data.get("decisions") if isinstance(data, dict) else data):
        if isinstance(d, dict) and s(d.get("id")):
            out[s(d.get("id"))] = d
    return out


def _safe(ctx: Ctx, batch: list[Node]) -> dict[str, dict]:
    if not batch:
        return {}
    try:
        return _check_batch(ctx, batch)
    except ContextOverflow:
        if len(batch) > 1:      # пачка не поместилась в окно модели — делим пополам
            mid = len(batch) // 2
            return {**_safe(ctx, batch[:mid]), **_safe(ctx, batch[mid:])}
        return {}
    except Exception as e:
        ctx.graph.log({"kind": "verifier_failed", "error": f"{type(e).__name__}: {e}"[:300]})
        return {}


# ----------------------------------------------------------------------------- слияние дублей
def _keeper_rank(n: Node) -> tuple:
    """Какое замечание из группы дублей остаётся: противоречие > уровень набора > серьёзность > доказательства."""
    p = n.payload
    return (
        0 if p["defect_type"] == "contradictory" else 1,
        0 if p["level"] == "set" else 1,
        SEVERITY_ORDER[p["severity"]],
        -len(p["evidence"]),
        n.id,
    )


def _same_place(a: Node, b: Node) -> bool:
    for ea in a.payload["evidence"]:
        for eb in b.payload["evidence"]:
            if ea["line_start"] <= eb["line_end"] and eb["line_start"] <= ea["line_end"]:
                return True
    return False


def _related(a: Node, b: Node) -> bool:
    """Страховка от ложных слияний: дубли обязаны быть об одном месте документа."""
    pa, pb = a.payload, b.payload
    if _same_place(a, b):
        return True
    if set(pa["req_ids"]) & set(pb["req_ids"]):
        return True
    return pa["level"] == pb["level"] == "set" and pa["criterion"] == pb["criterion"]


def _merge(ctx: Ctx, dup: Node, target: Node, reason: str) -> None:
    dup.state = "merged"
    dup.payload["verify"] = {"verdict": "duplicate", "duplicate_of": target.id, "reason": reason}
    dp, tp = dup.payload, target.payload
    tp["also"].append({"id": dup.id, "source": dp["source"], "title": dp["title"]})
    tp["also"] += dp["also"]
    for rid in dp["req_ids"]:
        if rid not in tp["req_ids"]:
            tp["req_ids"].append(rid)
            ctx.graph.link(target.id, rid, "about")
    for ev in dp["evidence"]:
        if len(tp["evidence"]) < 4 and not any(e["line_start"] == ev["line_start"] for e in tp["evidence"]):
            tp["evidence"].append(ev)
    if not tp.get("question") and dp.get("question"):
        tp["question"], tp["addressee"] = dp["question"], dp["addressee"]
    if SEVERITY_ORDER[dp["severity"]] < SEVERITY_ORDER[tp["severity"]]:
        tp["severity"] = dp["severity"]
    # какие клетки матрицы «требование × критерий» закрывает слитое замечание
    covers = tp.setdefault("covers", [])
    if dp["level"] == "req":
        covers += [[rid, dp["criterion"]] for rid in dp["req_ids"]]
    covers += dp.get("covers", [])
    ctx.graph.link(dup.id, target.id, "derived_from")
    ctx.graph.log({"kind": "finding_merged", "duplicate": dup.id, "into": target.id, "reason": reason[:200]})


def _row(n: Node) -> str:
    p = n.payload
    lines = ", ".join(f"L{e['line_start']}" for e in p["evidence"])
    return (
        f"{n.id} | {p['criterion']} | {p['defect_type']} | {p['severity']} | "
        f"{', '.join(p['req_ids']) or 'документ в целом'} | {lines} | {p['title']}. {p['problem'][:300]}"
    )


def _ask_groups(ctx: Ctx, text: str, label: str) -> list[dict]:
    system, user = prompts.load("dedup").render(findings=text)
    try:
        # ответ короткий; жёсткий лимит не даёт модели «зациклиться» на повторении групп
        data = ctx.llm.json("verifier", system, user, label=label, max_tokens=6000, grow=False, prompt="dedup")
    except LLMTruncated as e:
        # ответ оборван: берём группы, которые модель успела выдать целиком
        groups = [
            {"ids": re.findall(r"C-\d+", m.group(1)), "reason": "тот же дефект описан в другом замечании"}
            for m in re.finditer(r'\{[^{}]*"ids"\s*:\s*\[([^\]]*)\][^{}]*\}', e.text or "")
        ]
        ctx.graph.log({"kind": "dedup_salvaged", "groups": len(groups)})
        return groups
    except Exception as e:
        ctx.graph.log({"kind": "dedup_failed", "error": f"{type(e).__name__}: {e}"[:300]})
        return []
    return [g for g in lst(data.get("groups") if isinstance(data, dict) else data) if isinstance(g, dict)]


def _apply_groups(ctx: Ctx, groups: list[dict], by_id: dict[str, Node]) -> int:
    merged = 0
    for g in groups:
        ids = lst(g.get("ids")) or ([g.get("keep")] + lst(g.get("duplicates")))
        group = [by_id[i] for i in dict.fromkeys(s(x) for x in ids) if i in by_id and by_id[i].state == "confirmed"]
        if len(group) < 2:
            continue
        group.sort(key=_keeper_rank)
        keep = group[0]
        for dup in group[1:]:
            if _related(dup, keep):
                _merge(ctx, dup, keep, s(g.get("reason")) or "тот же дефект описан в другом замечании")
                merged += 1
    return merged


def _dedup(ctx: Ctx, conf: list[Node]) -> None:
    """Одно и то же могли найти инспектор и несколько рецензентов — оставляем одно замечание на дефект."""
    if len(conf) < 2:
        return
    by_id = {n.id: n for n in conf}

    # Проход 1: весь список (большой список — частями, отсортированными по месту в документе).
    limit = max(1_000, ctx.room(prompts.load("dedup").system) - 400)
    chunk: list[Node] = []
    size = 0
    for n in conf + [None]:
        row_len = len(_row(n)) + 1 if n is not None else 0
        if n is None or len(chunk) >= DEDUP_ROWS or (chunk and size + row_len > limit):
            if len(chunk) >= 2:
                _apply_groups(ctx, _ask_groups(ctx, "\n".join(_row(m) for m in chunk), "слияние дублей"), by_id)
            chunk, size = [], 0
        if n is not None:
            chunk.append(n)
            size += row_len

    # Проход 2: только замечания об одном и том же месте. В длинном списке модель часть таких пар пропускает,
    # а в короткой группе «строка 40: три замечания» видит их сразу.
    alive = [n for n in conf if n.state == "confirmed"]
    clusters: list[list[Node]] = []
    for n in alive:
        home = next((c for c in clusters if any(_same_place(n, m) for m in c)), None)
        (home.append(n) if home is not None else clusters.append([n]))
    clusters = [c for c in clusters if len(c) >= 2]
    if clusters:
        blocks = []
        for c in clusters:
            lines = sorted({e["line_start"] for n in c for e in n.payload["evidence"]})
            blocks.append(f"--- одно место документа (строки {', '.join(map(str, lines[:6]))}) ---\n" + "\n".join(_row(n) for n in c))
        text, size = [], 0
        limit = max(1_000, ctx.room(prompts.load("dedup").system) - 400)
        for b in blocks + [None]:
            if b is None or (text and size + len(b) > limit):
                _apply_groups(ctx, _ask_groups(ctx, "\n".join(text), "слияние дублей: одно место документа"), by_id)
                text, size = [], 0
            if b is not None:
                text.append(b)
                size += len(b)


def _renumber(ctx: Ctx) -> None:
    """Даёт кандидатам идентификаторы C-001… в порядке, не зависящем от того, какой воркер ответил первым.

    Без этого нумерация менялась бы от прогона к прогону, а с ней — запросы к модели и результат.
    """
    nodes = ctx.graph.of("finding")

    def key(n: Node) -> tuple:
        p = n.payload
        return (0 if p["source"] == "inspector" else 1, p["source"], (p["req_ids"] or [""])[0], _first_line(n),
                p["criterion"], p["title"], p["problem"])

    mapping = {n.id: f"C-{i:03d}" for i, n in enumerate(sorted(nodes, key=key), start=1)}
    ctx.graph.rename(mapping)


# ----------------------------------------------------------------------------- прогон
def run(ctx: Ctx, check: bool = True) -> None:
    """check=False — без модели-оппонента и слияния дублей (ValidationOptions.verify_pass=False):
    кандидаты, прошедшие проверку цитат кодом, подтверждаются как есть."""
    _renumber(ctx)
    proposed = sorted(ctx.graph.of("finding", "proposed"), key=lambda n: (_first_line(n), n.id))
    pre_dropped = len(ctx.graph.of("finding", "dismissed"))
    decisions: dict[str, dict] = {}
    if proposed and check:
        batches = [proposed[i : i + BATCH] for i in range(0, len(proposed), BATCH)]
        pool = ThreadPoolExecutor(max_workers=ctx.cfg.concurrency)
        stopped = False
        try:
            ctxs = [contextvars.copy_context() for _ in batches]
            for k, res in enumerate(pool.map(lambda c, b: c.run(_safe, ctx, b), ctxs, batches), start=1):
                decisions.update(res)
                ctx.tick(k, len(batches), "перепроверка замечаний")
        except BaseException:
            stopped = True
            raise
        finally:
            pool.shutdown(wait=not stopped, cancel_futures=stopped)
        # замечания, по которым модель не ответила, перепроверяем ещё раз маленькими пачками
        missing = [n for n in proposed if n.id not in decisions]
        for i in range(0, len(missing), 8):
            decisions.update(_safe(ctx, missing[i : i + 8]))

    unverified = 0
    for n in proposed:
        d = decisions.get(n.id)
        if not d:
            n.state = "confirmed"
            n.payload["verify"] = {"verdict": "keep", "reason": "не перепроверено верификатором"
                                   + (" (нет ответа модели)" if check else " (перепроверка выключена)")}
            unverified += 1
        else:
            sev = s(d.get("severity")).lower()
            if sev in SEVERITY:
                n.payload["severity"] = sev
            reason = s(d.get("reason"))
            if s(d.get("verdict")).lower() == "drop":
                n.state = "dismissed"
                n.payload["verify"] = {"verdict": "drop", "reason": reason or "отклонено верификатором"}
            else:
                n.state = "confirmed"
                n.payload["verify"] = {"verdict": "keep", "reason": reason}
        ctx.graph.log({
            "kind": "verifier_decision", "finding": n.id, "source": n.payload["source"], "verdict": n.payload["verify"]["verdict"],
            "severity": n.payload["severity"], "title": n.payload["title"], "reason": n.payload["verify"]["reason"][:300],
        })

    if check:
        _dedup(ctx, [n for n in proposed if n.state == "confirmed"])

    # финальная нумерация: по месту в документе
    final = sorted(ctx.graph.of("finding", "confirmed"), key=lambda n: (_first_line(n), SEVERITY_ORDER[n.payload["severity"]], n.id))
    for k, n in enumerate(final, start=1):
        n.payload["fid"] = f"{ctx.graph.prefix['finding']}-{k:03d}"
        if n.payload["defect_type"] == "contradictory" and len(n.payload["req_ids"]) >= 2:
            a = n.payload["req_ids"][0]
            for b in n.payload["req_ids"][1:]:
                ctx.graph.link(a, b, "conflicts")

    # вердикты по критериям приводим в соответствие с подтверждёнными замечаниями
    violated: dict[str, set[str]] = {}
    for n in final:
        if n.payload["level"] == "req":
            for rid in n.payload["req_ids"]:
                violated.setdefault(rid, set()).add(n.payload["criterion"])
        for rid, code in n.payload.get("covers", []):
            violated.setdefault(rid, set()).add(code)
    for r in ctx.graph.of("requirement"):
        v = r.payload["verdicts"]
        for code in I_CODES:
            if code in violated.get(r.id, set()):
                v[code] = "violation"
            elif v.get(code) == "violation":
                v[code] = "ok"      # нарушение заявлено, но замечание не прошло перепроверку
        r.state = "checked" if all(c in v for c in I_CODES) else "partial"

    ctx.meta["verification"] = {
        "candidates": len(proposed) + pre_dropped,
        "confirmed": len(final),
        "dropped": len(ctx.graph.of("finding", "dismissed")),
        "dropped_no_quote": pre_dropped,
        "merged": len(ctx.graph.of("finding", "merged")),
        "unverified": unverified,
    }
    v = ctx.meta["verification"]
    ctx.say(f"   кандидатов: {v['candidates']} → подтверждено: {v['confirmed']}, отклонено: {v['dropped']} "
            f"(из них кодом, без обращения к модели: {pre_dropped}), слито дублей: {v['merged']}")
