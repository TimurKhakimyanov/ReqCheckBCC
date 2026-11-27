"""Завершающие агенты: заполнение чек-листа ревью из документа и итоговое заключение."""
from __future__ import annotations

import json
import re

from .. import guard, prompts
from ..criteria import CRITICAL_TYPES, SEVERITY_ORDER
from ..rules import find_checklist
from .common import Ctx, clean, confirmed, findings_text, lst, render_fit, s, to_int

ANSWERS = ("Да", "Нет", "Частично", "Не требуется")
DECISIONS = ("нельзя", "можно с ограничениями", "можно")


def checklist(ctx: Ctx) -> None:
    """Если в документе есть незаполненный чек-лист ревью — агент заполняет его по факту."""
    rows = find_checklist(ctx.doc)
    if not rows:
        return
    rows_text = "\n".join(f"L{no} | {text}" for no, text in rows)
    system = user = ""
    for n in (60, 30, 12, 0):     # столько замечаний, сколько помещается в окно модели
        system, user = render_fit(
            ctx, prompts.load("checklist"), [(rows[0][0], rows[-1][0])], pad=8,
            findings=findings_text(ctx, confirmed(ctx)[:n]), rows=rows_text,
        )
        if ctx.budget.fits(system, user):
            break
    data = ctx.llm.json("reporter", system, user, label="чек-лист ревью из документа", prompt="checklist")
    by_line = {no: text for no, text in rows}
    out = []
    for r in lst(data.get("rows") if isinstance(data, dict) else data):
        if not isinstance(r, dict):
            continue
        no = to_int(r.get("line"))
        ans = s(r.get("answer"))
        if no in by_line and ans in ANSWERS:
            comment = guard.scrub(ctx, s(r.get("comment")), "чек-лист ревью", kinds="RF")
            out.append({"line": no, "item": clean(by_line[no]), "answer": ans, "comment": comment})
    done = {r["line"] for r in out}
    for no, text in rows:
        if no not in done:
            out.append({"line": no, "item": clean(text), "answer": "—", "comment": "агент не дал оценки"})
    ctx.meta["checklist"] = sorted(out, key=lambda r: r["line"])
    ctx.say(f"   заполнен чек-лист ревью из документа: {len(rows)} пунктов")


def stats(ctx: Ctx) -> dict:
    found = confirmed(ctx)
    reqs = ctx.graph.of("requirement")
    with_defects = {rid for f in found for rid in f.payload["req_ids"]}
    by_sev = {k: sum(1 for f in found if f.payload["severity"] == k) for k in SEVERITY_ORDER}
    by_type: dict[str, int] = {}
    by_crit: dict[str, int] = {}
    for f in found:
        by_type[f.payload["defect_type"]] = by_type.get(f.payload["defect_type"], 0) + 1
        by_crit[f.payload["criterion"]] = by_crit.get(f.payload["criterion"], 0) + 1
    return {
        "requirements": len(reqs),
        "requirements_with_defects": len(with_defects),
        "requirements_clean": len(reqs) - len(with_defects),
        "findings": len(found),
        "findings_req_level": sum(1 for f in found if f.payload["level"] == "req"),
        "findings_set_level": sum(1 for f in found if f.payload["level"] == "set"),
        "by_severity": by_sev,
        "by_type": by_type,
        "by_criterion": by_crit,
        "critical_by_type": {
            t: sum(1 for f in found if f.payload["severity"] == "critical" and f.payload["defect_type"] == t)
            for t in CRITICAL_TYPES
        },
        "questions_total": len(ctx.graph.of("question")),
        "questions_blocking": sum(1 for q in ctx.graph.of("question") if q.payload.get("priority") == "blocker"),
    }


_NUM = r"(\d+)"
_COUNT_CHECKS = (
    # (шаблон с числом, ключ статистики): число в тексте итога сверяется со статистикой и исправляется кодом
    (re.compile(_NUM + r"(?=\s+блокирующ\w+\s+вопрос)"), "questions_blocking"),
    (re.compile(_NUM + r"(?=\s+(?:уточняющ\w+\s+)?вопрос\w*\s+автору)"), "questions_total"),
    (re.compile(_NUM + r"(?=\s+критич\w+\s+(?:замечан|дефект|нарушен))"), "critical"),
    (re.compile(r"(?<=из\s)" + _NUM + r"(?=\s+требовани)"), "requirements"),
)


def fix_counts(text: str, st: dict) -> str:
    """Модель иногда называет в итоге числа, которых нет в статистике («15 блокирующих вопросов» при 9).
    Число перед известными словами сверяется со статистикой прогона: если оно больше фактического итога,
    оно заменяется итогом. Меньшие числа не трогаем — это может быть законный частичный счёт."""
    facts = {"questions_blocking": st["questions_blocking"], "questions_total": st["questions_total"],
             "critical": st["by_severity"]["critical"], "requirements": st["requirements"]}
    for rx, key in _COUNT_CHECKS:
        text = rx.sub(lambda m, k=key: str(facts[k]) if int(m.group(1)) > facts[k] else m.group(1), text)
    return text


def verdict(ctx: Ctx) -> None:
    st = stats(ctx)
    ctx.meta["stats"] = st
    found = sorted(confirmed(ctx), key=lambda f: (SEVERITY_ORDER[f.payload["severity"]], f.payload["fid"]))
    known = {f.payload["fid"] for f in found}
    questions = "\n".join(
        f"{q.id} [{q.payload['priority']}] {q.payload['question']}" for q in ctx.graph.of("question") if q.state == "open"
    ) or "(нет)"
    system = user = ""
    for n in (70, 40, 20, 10, 5):     # столько замечаний (сначала самые серьёзные), сколько помещается в окно модели
        system, user = prompts.load("verdict").render(
            title=ctx.doc.title,
            stats=json.dumps({k: v for k, v in st.items() if k != "by_criterion"}, ensure_ascii=False),
            findings=findings_text(ctx, found[:n]),
            questions=questions,
        )
        if ctx.budget.fits(system, user):
            break
    try:
        data = ctx.llm.json("reporter", system, user, label="итоговое заключение", prompt="verdict")
        if not isinstance(data, dict):
            data = {}
    except Exception as e:
        ctx.graph.log({"kind": "verdict_failed", "error": str(e)[:300]})
        data = {}

    decision = s(data.get("decision")).lower()
    if decision not in DECISIONS:
        decision = "нельзя" if st["by_severity"]["critical"] else "можно с ограничениями" if st["by_severity"]["major"] else "можно"
    # Предохранитель: модель не может разрешить разработку при критичных дефектах.
    guard_note = ""
    if st["by_severity"]["critical"] and decision == "можно":
        decision, guard_note = "можно с ограничениями", "решение ужесточено правилом: есть критичные дефекты"
    if not st["findings"] and decision != "можно":
        decision = "можно"
    fixes = []
    for f in lst(data.get("top_fixes"))[:10]:
        if isinstance(f, dict) and s(f.get("action")):
            fixes.append({
                "action": guard.scrub(ctx, s(f.get("action")), "итог: что исправить"),
                "why": guard.scrub(ctx, s(f.get("why")), "итог: что исправить"),
                "finding_ids": [x for x in (s(i) for i in lst(f.get("finding_ids"))) if x in known],
            })
    if not fixes:   # запасной вариант без модели: критичные замечания по порядку
        fixes = [
            {"action": f.payload["recommendation"] or f.payload["title"], "why": f.payload["title"], "finding_ids": [f.payload["fid"]]}
            for f in found[:7]
        ]
    ctx.meta["verdict"] = {
        "decision": decision,
        "development": fix_counts(guard.scrub(ctx, s(data.get("development")), "итог: разработка"), st),
        "testing": fix_counts(guard.scrub(ctx, s(data.get("testing")), "итог: тестирование"), st),
        "rationale": fix_counts(guard.scrub(ctx, s(data.get("rationale")), "итог: обоснование"), st),
        "top_fixes": fixes,
        "strengths": [guard.scrub(ctx, s(x), "итог: сильные стороны") for x in lst(data.get("strengths")) if s(x)][:4],
        "guard": guard_note,
    }
    ctx.say(f"   итог: начинать разработку и тестирование — {decision.upper()}")
