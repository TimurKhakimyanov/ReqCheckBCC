"""Аналитик уточнений: формирует вопросы автору ТЗ и обрабатывает ответы (human-in-the-loop).

Вопросы — отдельные узлы графа, связанные с замечаниями. Если человек ответил
(интерактивно или файлом ответов), агент-редактор предлагает исправленные формулировки
требований и отмечает, какие замечания снимаются.
"""
from __future__ import annotations

import json
from pathlib import Path

from .. import guard, prompts
from ..criteria import SEVERITY_ORDER
from .common import ADDRESSEES, Ctx, clean, confirmed, findings_text, lst, render_fit, s, spans_of

PRIORITY = {"blocker": "Блокирующий", "important": "Важный", "minor": "Желательный"}
_PORDER = {"blocker": 0, "important": 1, "minor": 2}


def ask(ctx: Ctx, limit: int = 20) -> None:
    """Готовит список уточняющих вопросов по подтверждённым замечаниям."""
    found = confirmed(ctx)
    source = [f for f in found if f.payload["severity"] in ("critical", "major") or f.payload.get("question")]
    source.sort(key=lambda f: (SEVERITY_ORDER[f.payload["severity"]], f.payload["fid"]))
    if not source:
        return
    # Берём столько замечаний (сначала самые серьёзные), сколько помещается в окно модели вместе с документом.
    system = user = ""
    for n in (80, 50, 30, 15, 8, 4):
        system, user = render_fit(
            ctx, prompts.load("clarifier"), spans_of(source[:n], ctx), pad=6,
            findings=findings_text(ctx, source[:n], with_question=True), limit=limit,
        )
        if ctx.budget.fits(system, user):
            break
    data = ctx.llm.json("clarifier", system, user, label="вопросы автору ТЗ", prompt="clarifier")
    by_fid = {f.payload["fid"]: f for f in found}
    items = []
    for q in lst(data.get("questions") if isinstance(data, dict) else data):
        if not isinstance(q, dict) or len(s(q.get("question"))) < 10:
            continue
        fids = [x for x in (s(i) for i in lst(q.get("finding_ids"))) if x in by_fid]
        prio = s(q.get("priority")).lower()
        addressee = s(q.get("addressee"))
        # контроль достоверности: вопрос не должен ссылаться на несуществующие строки и объекты
        text = guard.scrub(ctx, s(q.get("question")), "уточняющий вопрос", kinds="RFQ")
        fake = guard.unverified_quotes(ctx, text)
        if fake:
            ctx.graph.log({"kind": "guard_question_quote", "question": text[:160], "unverified": fake[:3]})
            ctx.meta["guard_question_quotes"] = ctx.meta.get("guard_question_quotes", 0) + len(fake)
        items.append({
            "question": text,
            "why": guard.scrub(ctx, s(q.get("why")), "обоснование вопроса", kinds="RFQ"),
            "addressee": addressee if addressee in ADDRESSEES else "Аналитик",
            "priority": prio if prio in PRIORITY else "important",
            "finding_ids": fids,
            "options": [clean(s(o), 240) for o in lst(q.get("options")) if s(o)][:4],
        })
    items.sort(key=lambda q: _PORDER[q["priority"]])
    for q in items[:limit]:
        qid = ctx.graph.new_id(ctx.graph.prefix["question"], 2)
        req_ids: list[str] = []
        for fid in q["finding_ids"]:
            for rid in by_fid[fid].payload["req_ids"]:
                if rid not in req_ids:
                    req_ids.append(rid)
        ctx.graph.add("question", qid, "open", **q, req_ids=req_ids)
        for fid in q["finding_ids"]:
            ctx.graph.link(qid, by_fid[fid].id, "clarifies")
            by_fid[fid].payload.setdefault("questions", []).append(qid)
    qs = ctx.graph.of("question")
    ctx.say(f"   вопросов автору ТЗ: {len(qs)} (блокирующих: {sum(1 for q in qs if q.payload['priority'] == 'blocker')})")


# ----------------------------------------------------------------------------- ответы человека
def interactive(ctx: Ctx, max_questions: int = 5) -> dict[str, str]:
    """Задаёт вопросы в консоли. Enter — пропустить, q — закончить."""
    qs = sorted(ctx.graph.of("question"), key=lambda q: (_PORDER[q.payload["priority"]], q.id))[:max_questions]
    answers: dict[str, str] = {}
    if not qs:
        return answers
    print("\n" + "=" * 78)
    print("Агент задаёт уточняющие вопросы по ТЗ.")
    print("Ответьте номером варианта или своим текстом. Enter — пропустить, q — закончить.")
    print("=" * 78)
    for i, q in enumerate(qs, start=1):
        p = q.payload
        print(f"\n[{i}/{len(qs)}] {q.id} · {PRIORITY[p['priority']]} · кому: {p['addressee']}")
        print(f"  {p['question']}")
        if p["why"]:
            print(f"  Зачем: {p['why']}")
        for k, opt in enumerate(p["options"], start=1):
            print(f"    {k}) {opt}")
        try:
            ans = input("  Ответ> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if ans.lower() in ("q", "й", "quit", "exit"):
            break
        if not ans:
            continue
        if ans.isdigit() and 1 <= int(ans) <= len(p["options"]):
            ans = p["options"][int(ans) - 1]
        answers[q.id] = ans
    return answers


def load_answers(ctx: Ctx, path: str) -> dict[str, str]:
    """Файл ответов: {"Q-01": "ответ", …} или [{"id"/"question": …, "answer": …}]."""
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    qs = {q.id: q for q in ctx.graph.of("question")}
    by_text = {q.payload["question"].strip().lower(): q.id for q in qs.values()}
    out: dict[str, str] = {}
    rows = raw.items() if isinstance(raw, dict) else [(r.get("id") or r.get("question"), r) for r in raw if isinstance(r, dict)]
    for key, val in rows:
        ans = s(val.get("answer")) if isinstance(val, dict) else s(val)
        qtext = s(val.get("question")).lower() if isinstance(val, dict) else ""
        qid = key if key in qs else by_text.get(qtext) or by_text.get(s(key).lower())
        if qid and ans:
            out[qid] = ans
    return out


def resolve(ctx: Ctx, answers: dict[str, str]) -> None:
    """По ответам автора предлагает исправленные редакции требований."""
    if not answers:
        return
    found = {f.payload["fid"]: f for f in confirmed(ctx)}
    related, lines = [], []
    for qid, ans in answers.items():
        q = ctx.graph.get(qid)
        if not q:
            continue
        q.state = "answered"
        q.payload["answer"] = ans
        aid = ctx.graph.new_id("A", 2)
        ctx.graph.add("answer", aid, "confirmed", text=ans, question=qid)
        ctx.graph.link(aid, qid, "answers")
        lines.append(f"{qid} (требования: {', '.join(q.payload['req_ids']) or '—'}; замечания: {', '.join(q.payload['finding_ids']) or '—'})\n  Вопрос: {q.payload['question']}\n  Ответ автора: {ans}")
        related += [found[f] for f in q.payload["finding_ids"] if f in found and found[f] not in related]
    if not lines:
        return
    system, user = render_fit(
        ctx, prompts.load("resolver"), spans_of(related, ctx), pad=6,
        answers="\n".join(lines), findings=findings_text(ctx, related),
    )
    data = ctx.llm.json("clarifier", system, user, label="редакции по ответам автора", prompt="resolver")
    for r in lst(data.get("resolutions") if isinstance(data, dict) else data):
        if not isinstance(r, dict):
            continue
        q = ctx.graph.get(s(r.get("question_id")))
        if not q or q.kind != "question":
            continue
        rewrites = []
        for rw in lst(r.get("rewrites")):
            if isinstance(rw, dict) and ctx.graph.get(s(rw.get("req_id"))) and s(rw.get("new_text")):
                rewrites.append({"req_id": s(rw.get("req_id")), "new_text": s(rw.get("new_text"))})
        closes = [x for x in (s(i) for i in lst(r.get("closes_findings"))) if x in found]
        q.payload["resolution"] = {"rewrites": rewrites, "closes_findings": closes, "note": s(r.get("note"))}
        for fid in closes:
            found[fid].payload["resolved_by"] = q.id
    ctx.say(f"   получено ответов: {len(answers)}; предложены редакции требований")
