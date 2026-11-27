"""Верификатор: независимая перепроверка замечаний перед отчётом.

Ступени:
  1) код: замечание без цитаты, найденной в документе, отклоняется ещё при записи (common.record_finding);
  2) модель-оппонент проверяет каждое замечание по тексту и выравнивает серьёзность;
  3) слияние дублей: сначала код сливает явные повторы (то же место документа и та же формулировка), затем
     модель в два прохода — по всему списку и отдельно по замечаниям об одном месте документа; модель предлагает
     группы, код решает, что объединять и какое замечание оставить. Если модель не ответила, остаётся слияние
     кодом, а в отчёт попадает предупреждение;
  4) калибровка серьёзности: слитое замечание получает медиану оценок по всем его повторам, затем модель
     один раз смотрит на итоговый список целиком и расставляет уровни относительно друг друга (по пачкам
     верификатор оценивает каждое замечание отдельно, и почти всё выходит «существенным»); код не даёт опустить
     противоречие ниже «существенного»;
  5) код: пересчёт вердиктов по подтверждённым замечаниям, финальная нумерация D-001…
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
    # оценки серьёзности всех повторов: итоговая считается по ним в _settle_severity
    tp.setdefault("severity_votes", [tp["severity"]]).extend(dp.get("severity_votes") or [dp["severity"]])
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


# ----------------------------------------------------------------------------- слияние кодом (без модели)
_WORD = re.compile(r"[a-zа-яё0-9]{3,}")
_STOP = frozenset(
    "для при или это что как без над под нет его она они оно был быть есть если чтобы также так уже все или либо "
    "между после перед когда где который которая которые которых может могут должен должна должно нужно надо один "
    "одна одно этот эта эти того тот том тем чем про the and for not".split()
)
TITLE_SIM = 0.5       # доля общих слов в заголовках, с которой замечания об одном месте считаются повтором
TEXT_SIM = 0.4        # то же для заголовка вместе с началом описания


def _words(text: str) -> frozenset[str]:
    return frozenset(w[:5] for w in _WORD.findall((text or "").lower().replace("ё", "е")) if w not in _STOP)


def _jaccard(a: frozenset[str], b: frozenset[str]) -> float:
    return len(a & b) / len(a | b) if a and b else 0.0


def _obvious_duplicates(a: Node, b: Node) -> bool:
    """Повтор, который виден без модели. Пороги подобраны так, чтобы не сливать разные дефекты одного места:
    «статус 201 не описан» и «под статусом 200 пример с ERROR» остаются отдельными замечаниями."""
    pa, pb = a.payload, b.payload
    lines_a = {e["line_start"] for e in pa["evidence"]}
    lines_b = {e["line_start"] for e in pb["evidence"]}
    if pa["defect_type"] == pb["defect_type"] == "contradictory" and len(lines_a) >= 2 and lines_a == lines_b:
        return True     # противоречие между одними и теми же двумя местами документа
    if not _same_place(a, b):
        return False
    if _jaccard(_words(pa["title"]), _words(pb["title"])) >= TITLE_SIM:
        return True
    return _jaccard(_words(pa["title"] + " " + pa["problem"][:400]),
                    _words(pb["title"] + " " + pb["problem"][:400])) >= TEXT_SIM


def _code_groups(conf: list[Node]) -> list[dict]:
    """Группы явных повторов: связные компоненты по _obvious_duplicates."""
    parent = {n.id: n.id for n in conf}

    def root(x: str) -> str:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for i, a in enumerate(conf):
        for b in conf[i + 1:]:
            if root(a.id) != root(b.id) and _obvious_duplicates(a, b):
                parent[root(b.id)] = root(a.id)
    groups: dict[str, list[str]] = {}
    for n in conf:
        groups.setdefault(root(n.id), []).append(n.id)
    return [{"ids": ids, "reason": "то же место документа и та же формулировка (слито правилом, без модели)"}
            for ids in groups.values() if len(ids) >= 2]


def _settle_severity(conf: list[Node]) -> None:
    """Серьёзность слитого замечания — медиана оценок верификатора по всем повторам (при равенстве — строже).
    Один и тот же дефект рецензенты оценивают по-разному; максимум завышал бы долю критичных."""
    for n in conf:
        votes = n.payload.pop("severity_votes", None)
        if n.state != "confirmed" or not votes:
            continue
        ranks = sorted(SEVERITY_ORDER[v] for v in votes)
        rank = ranks[(len(ranks) - 1) // 2]
        n.payload["severity"] = next(k for k, v in SEVERITY_ORDER.items() if v == rank)


def _calibrate(ctx: Ctx, conf: list[Node]) -> None:
    """Калибровка серьёзности по итоговому списку. Верификатор оценивает замечания пачками и по отдельности,
    поэтому почти все выходят «существенными»; здесь модель видит список целиком и сравнивает замечания между
    собой. Ответ принимается, только если модель оценила большинство замечаний; противоречие не опускается ниже
    «существенного». Сбой шага ничего не меняет — остаются оценки верификатора."""
    alive = [n for n in conf if n.state == "confirmed"]
    if len(alive) < 6:      # на коротком списке сравнивать не с чем
        return
    system, user = prompts.load("calibrator").render(title=ctx.doc.title, findings="\n".join(_row(n) for n in alive))
    if not ctx.budget.fits(system, user):
        return
    try:
        data = ctx.llm.json("verifier", system, user, label="калибровка серьёзности", prompt="calibrator")
    except Exception as e:
        ctx.graph.log({"kind": "calibration_failed", "error": f"{type(e).__name__}: {e}"[:300]})
        return
    levels = {}
    for d in lst(data.get("levels") if isinstance(data, dict) else data):
        if isinstance(d, dict) and s(d.get("severity")).lower() in SEVERITY:
            levels[s(d.get("id"))] = d
    by_id = {n.id: n for n in alive}
    if sum(1 for i in levels if i in by_id) < 0.7 * len(alive):
        ctx.graph.log({"kind": "calibration_failed", "error": f"оценено {len(levels)} из {len(alive)} замечаний"})
        return
    changed = 0
    for fid, d in levels.items():
        n = by_id.get(fid)
        if n is None:
            continue
        new, old = s(d.get("severity")).lower(), n.payload["severity"]
        if n.payload["defect_type"] == "contradictory" and new == "minor":
            new = "major"
        if new != old:
            n.payload["severity"] = new
            changed += 1
            ctx.graph.log({"kind": "severity_calibrated", "finding": n.id, "from": old, "to": new,
                           "title": n.payload["title"], "reason": s(d.get("reason"))[:200]})
    ctx.meta["calibrated"] = changed
    ctx.say(f"   калибровка серьёзности: изменено оценок — {changed} из {len(alive)}")


def _normalize_criteria(ctx: Ctx, nodes: list[Node]) -> None:
    """Критерий набора по типу дефекта. Рецензент относит замечание к «своему» критерию, из-за чего противоречие
    попадало в «полноту», а пропуск — в «непротиворечивость»."""
    for n in nodes:
        p = n.payload
        if p["level"] != "set":
            continue
        new = None
        if p["defect_type"] == "contradictory" and p["criterion"] != "S2":
            new = "S2"
        elif p["defect_type"] == "incomplete" and p["criterion"] == "S2":
            new = "S1"
        if new:
            ctx.graph.log({"kind": "criterion_normalized", "finding": n.id, "from": p["criterion"], "to": new})
            p["criterion"] = new


def _ask_groups(ctx: Ctx, text: str, label: str) -> list[dict] | None:
    """Группы дублей от модели. None — модель не ответила (ошибка или пустой оборванный ответ)."""
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
        if not groups:      # ответ оборван до первой группы (например, лимит ушёл на рассуждения модели)
            ctx.graph.log({"kind": "dedup_failed", "error": f"LLMTruncated: {e}"[:300]})
            return None
        return groups
    except Exception as e:
        ctx.graph.log({"kind": "dedup_failed", "error": f"{type(e).__name__}: {e}"[:300]})
        return None
    return [g for g in lst(data.get("groups") if isinstance(data, dict) else data) if isinstance(g, dict)]


def _apply_groups(ctx: Ctx, groups: list[dict] | None, by_id: dict[str, Node]) -> int:
    merged = 0
    if groups is None:
        ctx.meta["dedup_failed"] = ctx.meta.get("dedup_failed", 0) + 1
        return 0
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

    # Проход 0: явные повторы сливает код. Модели остаются случаи, где нужен смысл, а не совпадение слов;
    # если модель не ответит, отчёт всё равно не будет состоять из повторов.
    ctx.meta["dedup_by_code"] = _apply_groups(ctx, _code_groups(conf), by_id)
    conf = [n for n in conf if n.state == "confirmed"]
    if len(conf) < 2:
        return

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

    kept = [n for n in proposed if n.state == "confirmed"]
    _normalize_criteria(ctx, kept)
    if check:
        _dedup(ctx, kept)
        _settle_severity(kept)
        _calibrate(ctx, kept)
        if ctx.meta.get("dedup_failed"):
            ctx.say("   слияние дублей: модель не ответила, слиты только явные повторы (правилом, без модели)")

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
