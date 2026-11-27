"""Контроль достоверности: всё, что модель утверждает о документе, сверяется с документом кодом.

Модель может «галлюцинировать» тремя способами — на каждый есть проверка:

  1) выдуманная или искажённая цитата  -> цитата ищется в тексте (textmatch); в отчёт идёт фактический
                                          текст документа, а не слова модели; не нашлась — замечание отклоняется;
  2) цитата внутри рассуждения         -> фрагменты в «ёлочках» из текста замечания тоже ищутся в документе;
                                          ненайденные показываются верификатору и считаются в отчёте;
  3) ссылка на несуществующий объект   -> номера строк (L…), требований (R-…), замечаний (F-…) и вопросов (Q-…)
                                          проверяются по документу и графу; несуществующие удаляются из текста.

Каждое замечание получает уровень привязки к тексту:
  exact — цитата совпала дословно;
  fuzzy — совпала с небольшим искажением, заменена текстом документа;
  line  — цитата не нашлась, но слова взяты из указанной строки; привязка слабая.
"""
from __future__ import annotations

import re
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .agents.common import Ctx
    from .graph import Node

LEVELS = {"exact": "дословно", "fuzzy": "с искажением, исправлено", "line": "по строке (слабая привязка)"}
_INLINE = re.compile(r"«([^«»]{15,300})»")
_LINE_REF = re.compile(r"\bL(\d{1,6})\b")


def level(score: float) -> str:
    if score >= 0.999:
        return "exact"
    if score >= 0.8:
        return "fuzzy"
    return "line"


def _vocabulary(ctx: "Ctx") -> set[str]:
    """Основы слов документа (первые 5 букв) — чтобы отличать пересказ терминов документа от выдумки."""
    if "_vocab" not in ctx.meta:
        words = re.findall(r"[a-zа-яё0-9]{3,}", ctx.index.text)
        ctx.meta["_vocab"] = {w[:5] for w in words}
    return ctx.meta["_vocab"]


def unverified_quotes(ctx: "Ctx", text: str) -> list[str]:
    """Фрагменты в «ёлочках», которых нет в документе.

    Короткий фрагмент или фрагмент из слов документа в другой форме («исходным итогом» вместо
    «исходный итог») — это пересказ термина, а не выдуманная цитата; такие не считаются.
    """
    out = []
    vocab = _vocabulary(ctx)
    for frag in _INLINE.findall(text or ""):
        frag = frag.strip()
        if len(frag) < 25 or not re.search(r"[A-Za-zА-Яа-яЁё]{3}", frag):
            continue
        if ctx.index.find(frag, min_score=0.78) is not None:
            continue
        words = re.findall(r"[a-zа-яё0-9]{4,}", frag.lower().replace("ё", "е"))
        if words and sum(1 for w in words if w[:5] in vocab) / len(words) >= 0.8:
            continue    # слова те же, что в документе: пересказ, а не выдумка
        out.append(frag)
    return out


def bad_line_refs(ctx: "Ctx", text: str) -> list[str]:
    n = len(ctx.doc.lines)
    return sorted({f"L{m}" for m in _LINE_REF.findall(text or "") if not (1 <= int(m) <= n)})


_KIND_OF_LETTER = {"R": "req", "F": "finding", "Q": "question"}


def _id_ref(ctx: "Ctx") -> re.Pattern:
    """Шаблон идентификаторов отчёта. Префиксы берутся из графа: если документ сам использует R-…,
    отчёт нумерует требования иначе (REQ-…), и ссылки на требования документа не считаются выдумкой."""
    pref = ctx.graph.prefix
    alts = "|".join(re.escape(pref[k]) for k in ("req", "finding", "question"))
    return re.compile(rf"(?<![\w-])({alts})-(\d{{2,4}})\b")


def unknown_ids(ctx: "Ctx", text: str, kinds: str = "RFQ") -> list[str]:
    known_f = {f.payload.get("fid") for f in ctx.graph.of("finding", "confirmed")}
    pref = ctx.graph.prefix
    wanted = {pref[_KIND_OF_LETTER[k]]: _KIND_OF_LETTER[k] for k in kinds}
    out = []
    for p, num in _id_ref(ctx).findall(text or ""):
        kind = wanted.get(p)
        if kind is None:
            continue
        ref = f"{p}-{num}"
        if kind == "finding":
            ok = ref in known_f
        else:
            node = ctx.graph.get(ref)
            ok = node is not None and node.kind == ("requirement" if kind == "req" else "question")
        if not ok and ref not in out:
            out.append(ref)
    return out


def scrub(ctx: "Ctx", text: str, where: str, kinds: str = "RFQ") -> str:
    """Удаляет из текста ссылки на несуществующие требования, замечания и вопросы.
    kinds — какие ссылки проверять: R — требования, F — замечания, Q — вопросы."""
    if not text:
        return text
    bad = unknown_ids(ctx, text, kinds)
    lines = bad_line_refs(ctx, text)
    if not bad and not lines:
        return text
    for ref in bad + lines:
        text = re.sub(rf"\b{re.escape(ref)}\b", "", text)
    text = re.sub(r"\(\s*[,;/и ]*\s*\)", "", text)          # пустые скобки
    text = re.sub(r"\s+([,.;:])", r"\1", text)
    text = re.sub(r"([,;])(\s*[,;])+", r"\1", text)
    text = re.sub(r"\(\s*[,;]\s*", "(", text)
    text = re.sub(r"\s{2,}", " ", text).strip()
    ctx.graph.log({"kind": "guard_refs_removed", "where": where, "refs": bad + lines})
    ctx.meta.setdefault("guard_removed_refs", []).append({"where": where, "refs": bad + lines})
    return text


def assess(ctx: "Ctx", payload: dict) -> dict:
    """Оценка привязки замечания к тексту. Возвращает запись для payload['grounding']."""
    levels = [level(e.get("score", 0)) for e in payload.get("evidence", [])]
    best = "exact" if "exact" in levels else "fuzzy" if "fuzzy" in levels else "line" if levels else "none"
    return {
        "level": best,
        "evidence_levels": levels,
        "unverified_quotes": unverified_quotes(ctx, payload.get("problem", "")),
    }


def weak(g: dict) -> bool:
    """Замечание держится только на слабой привязке и при этом цитирует то, чего в документе нет."""
    return g["level"] == "line" and bool(g["unverified_quotes"])


def summary(ctx: "Ctx") -> dict:
    """Сводка контроля достоверности для отчёта."""
    findings = ctx.graph.of("finding")
    by_source: dict[str, dict[str, int]] = {}
    for f in findings:
        row = by_source.setdefault(f.payload["source"], {
            "candidates": 0, "no_quote": 0, "weak": 0, "dropped": 0, "merged": 0, "confirmed": 0,
        })
        row["candidates"] += 1
        reason = (f.payload.get("verify") or {}).get("reason", "")
        if f.state == "confirmed":
            row["confirmed"] += 1
        elif f.state == "merged":
            row["merged"] += 1
        elif "цитата не найдена" in reason:
            row["no_quote"] += 1
        elif "слабая привязка" in reason:
            row["weak"] += 1
        else:
            row["dropped"] += 1
    conf = [f for f in findings if f.state == "confirmed"]
    ev_levels = {"exact": 0, "fuzzy": 0, "line": 0}
    for f in conf:
        for e in f.payload["evidence"]:
            ev_levels[level(e.get("score", 0))] += 1
    inline_bad = sum(len((f.payload.get("grounding") or {}).get("unverified_quotes", [])) for f in conf)
    removed = ctx.meta.get("guard_removed_refs", [])
    total = len(findings)
    rejected_by_code = sum(r["no_quote"] + r["weak"] for r in by_source.values())
    return {
        "candidates": total,
        "rejected_by_code": rejected_by_code,
        "rejected_by_verifier": sum(r["dropped"] for r in by_source.values()),
        "merged": sum(r["merged"] for r in by_source.values()),
        "confirmed": len(conf),
        "evidence_levels": ev_levels,
        "evidence_total": sum(ev_levels.values()),
        "inline_quotes_unverified": inline_bad,
        "removed_refs": sum(len(r["refs"]) for r in removed),
        "removed_refs_detail": removed,
        "by_source": by_source,
        "requirements_verbatim": len(ctx.graph.of("requirement")),
    }
