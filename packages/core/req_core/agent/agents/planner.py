"""Планировщик: раскладывает проверку на интенты, раздаёт их воркерам и следит за покрытием.

Цикл (раунд):
  планировщик: какие клетки матрицы «требование × критерий» и какие проверки набора не закрыты?
      -> создаёт интенты (очередь работы, frontier)
  воркеры: параллельно разбирают очередь, пишут вердикты и замечания в граф
  планировщик: считает покрытие; непокрытое уходит в следующий раунд меньшими пачками

Критерий остановки жёсткий: матрица заполнена и все рецензенты отработали (либо исчерпаны
раунды). Это защита от «ранней остановки», когда модель пропустила часть требований.

Интент, запрос которого не поместился в окно модели (ContextOverflow) или ответ которого был
оборван, не теряется: его требования уходят в следующий раунд пачками вдвое меньше.
"""
from __future__ import annotations

import contextvars
from concurrent.futures import ThreadPoolExecutor, as_completed

from ..criteria import I_CODES
from ..graph import Node
from . import inspector, reviewers
from .common import Ctx

MAX_ROUNDS = 4


def _uncovered_reqs(ctx: Ctx) -> list[str]:
    reqs = sorted(ctx.graph.of("requirement"), key=lambda n: n.payload["line_start"])
    return [r.id for r in reqs if any(c not in r.payload["verdicts"] for c in I_CODES)]


def _pending_reviews(ctx: Ctx) -> list[tuple[str, int]]:
    done = {(i.payload["perspective"], i.payload["part"]) for i in ctx.graph.of("intent", "done") if i.payload["task"] == "review"}
    parts = range(len(reviewers.doc_parts(ctx)))
    return [(p["key"], k) for p in reviewers.PERSPECTIVES for k in parts if (p["key"], k) not in done]


def _plan(ctx: Ctx, round_no: int) -> list[Node]:
    intents: list[Node] = []
    n_parts = len(reviewers.doc_parts(ctx))
    # Ревью набора ставим в очередь первым: это самые долгие задания, они должны идти параллельно с инспекцией.
    for key, part in _pending_reviews(ctx):
        title = f"Ревью набора: {reviewers.BY_KEY[key]['title']}" + (f" (часть {part + 1}/{n_parts})" if n_parts > 1 else "")
        intents.append(ctx.graph.add(
            "intent", ctx.graph.new_id("INT"), "open",
            task="review", round=round_no, perspective=key, part=part, priority=1, title=title,
        ))
    todo = _uncovered_reqs(ctx)
    size = ctx.cfg.batch_size if round_no == 1 else max(1, ctx.cfg.batch_size // (2 ** (round_no - 1)))
    for i in range(0, len(todo), size):
        batch = todo[i : i + size]
        intents.append(ctx.graph.add(
            "intent", ctx.graph.new_id("INT"), "open",
            task="inspect", round=round_no, req_ids=batch, priority=2,
            title=f"Проверить {batch[0]}…{batch[-1]} по критериям I1–I9",
        ))
    for i in intents:
        ctx.graph.log({"kind": "intent_created", "intent": i.id, "task": i.payload["task"], "round": round_no, "title": i.payload["title"]})
    return intents


def _work(ctx: Ctx, intent: Node) -> None:
    intent.state = "running"
    try:
        if intent.payload["task"] == "inspect":
            inspector.inspect(ctx, intent.id, intent.payload["req_ids"])
        else:
            reviewers.review(ctx, intent.id, intent.payload["perspective"], intent.payload["part"])
        intent.state = "done"
    except Exception as e:  # воркер не должен ронять весь прогон: интент вернётся в следующий раунд
        intent.state = "failed"
        intent.payload["error"] = f"{type(e).__name__}: {e}"[:300]
    ctx.graph.log({"kind": "intent_finished", "intent": intent.id, "state": intent.state, "error": intent.payload.get("error", "")})


def run(ctx: Ctx) -> None:
    rounds = 0
    for round_no in range(1, MAX_ROUNDS + 1):
        intents = _plan(ctx, round_no)
        if not intents:
            break
        rounds = round_no
        n_ins = sum(1 for i in intents if i.payload["task"] == "inspect")
        ctx.say(f"   раунд {round_no}: интентов {len(intents)} (ревью набора: {len(intents) - n_ins}, инспекция: {n_ins}), воркеров: {ctx.cfg.concurrency}")
        pool = ThreadPoolExecutor(max_workers=ctx.cfg.concurrency)
        stopped = False
        try:
            # контекст вызывающего потока (contextvars) — чтобы логи воркера относились к своему прогону
            futures = {pool.submit(contextvars.copy_context().run, _work, ctx, i): i for i in intents}
            for k, fut in enumerate(as_completed(futures), start=1):
                fut.result()        # отмена прогона и фатальные ошибки провайдера (BaseException) — наружу
                i = futures[fut]
                mark = "✓" if i.state == "done" else "✗"
                ctx.say(f"     {mark} {i.id} {i.payload['title']}" + (f" — {i.payload.get('error')}" if i.state != "done" else ""))
                ctx.tick(k, len(intents), i.payload["title"])
        except BaseException:
            stopped = True
            raise
        finally:
            pool.shutdown(wait=not stopped, cancel_futures=stopped)

    reqs = ctx.graph.of("requirement")
    total = len(reqs) * len(I_CODES)
    filled = sum(1 for r in reqs for c in I_CODES if c in r.payload["verdicts"])
    pending = _pending_reviews(ctx)
    ctx.meta["coverage"] = {
        "rounds": rounds,
        "cells_total": total,
        "cells_filled": filled,
        "uncovered_reqs": _uncovered_reqs(ctx),
        "reviews_total": len(reviewers.PERSPECTIVES) * len(reviewers.doc_parts(ctx)),
        "reviews_failed": sorted({k for k, _ in pending}),
        "intents": len(ctx.graph.of("intent")),
        "intents_failed": len(ctx.graph.of("intent", "failed")),
    }
    pct = 100 * filled // total if total else 0
    ctx.say(f"   покрытие матрицы «требование × критерий»: {filled}/{total} ({pct}%), раундов: {rounds}")
