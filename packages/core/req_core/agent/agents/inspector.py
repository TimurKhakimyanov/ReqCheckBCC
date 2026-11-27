"""Инспектор (воркер): проверяет каждое требование по 9 критериям ISO 29148 п.5.2.5."""
from __future__ import annotations

import json

from .. import guard, prompts
from ..criteria import I_CODES, INDIVIDUAL, REQ_TYPES, criteria_block
from .common import Ctx, hints_text, lst, record_finding, render_fit, s

CONTEXT_LIMIT = 80_000   # даже если окно модели огромное, инспектору хватает окрестности требований
_STATUS = {"ok": "ok", "violation": "violation", "na": "na", "n/a": "na", "нарушение": "violation", "нарушен": "violation"}


def inspect(ctx: Ctx, intent_id: str, req_ids: list[str]) -> None:
    nodes = [ctx.graph.get(r) for r in req_ids]
    nodes = [n for n in nodes if n]
    if not nodes:
        return
    lo = min(n.payload["line_start"] for n in nodes)
    hi = max(n.payload["line_end"] for n in nodes)
    reqs_json = json.dumps(
        [
            {
                "id": n.id,
                "doc_id": n.payload["doc_id"],
                "lines": f"L{n.payload['line_start']}–L{n.payload['line_end']}",
                "type": REQ_TYPES.get(n.payload["type"], n.payload["type"]),
                "section": n.payload["section"],
                "text": n.payload["text"],
            }
            for n in nodes
        ],
        ensure_ascii=False,
        indent=1,
    )
    hints = "\n".join(
        h for h in (hints_text(ctx, n.payload["line_start"], n.payload["line_end"]) for n in nodes) if h != "(нет)"
    ) or "(нет)"
    # Документ целиком, если он небольшой; иначе окно вокруг проверяемых требований (сколько поместится).
    system, user = render_fit(
        ctx, prompts.load("inspector"), [(lo, hi)], pad=60, cap=CONTEXT_LIMIT,
        criteria=criteria_block(INDIVIDUAL), requirements=reqs_json, hints=hints,
    )
    data = ctx.llm.json("inspector", system, user, label=f"{req_ids[0]}…{req_ids[-1]}", prompt="inspector")
    results = data.get("results") if isinstance(data, dict) else data
    for res in lst(results):
        if not isinstance(res, dict):
            continue
        rid = s(res.get("id"))
        node = ctx.graph.get(rid)
        if not node or rid not in req_ids:
            continue
        verdicts = res.get("verdicts") if isinstance(res.get("verdicts"), dict) else {}
        for code in I_CODES:
            st = _STATUS.get(s(verdicts.get(code)).lower())
            if st:
                node.payload["verdicts"][code] = st
        span = (node.payload["line_start"], node.payload["line_end"])
        for f in lst(res.get("findings")):
            if not isinstance(f, dict):
                continue
            quote = s(f.get("quote")) or node.payload["quote"]
            fn = record_finding(
                ctx, source="inspector", level="req", raw=f, req_ids=[rid],
                evidence_raw=[{"quote": quote, "line": span[0]}], span=span,
                intent=intent_id, allowed_codes=I_CODES,
            )
            if fn is not None and fn.state == "dismissed" and not fn.payload["evidence"]:
                # Цитата не найдена, но замечание относится к этому требованию: цитируем само требование.
                # Привязка считается слабой; если при этом в тексте замечания есть выдуманные цитаты — оно отклоняется.
                fn.payload["evidence"] = [{
                    "line_start": span[0], "line_end": span[1], "quote": node.payload["quote"],
                    "where": node.payload["where"], "score": 0.5,
                }]
                g = guard.assess(ctx, fn.payload)
                fn.payload["grounding"] = g
                if guard.weak(g):
                    fn.payload["verify"] = {"verdict": "drop", "reason": "слабая привязка: цитата искажена, а в тексте замечания есть цитаты, которых нет в документе"}
                else:
                    fn.payload["verify"] = {}
                    fn.state = "proposed"
        ctx.graph.link(intent_id, rid, "covers")
