from __future__ import annotations

import asyncio
import logging
from collections import defaultdict
from datetime import date, datetime, time, timedelta, timezone

from fastapi import APIRouter, Query
from sqlalchemy import func, select, text
from starlette.concurrency import run_in_threadpool

from ..config import get_settings
from ..db import SessionLocal
from ..deps import DB, CurrentUser, Svc
from ..models import AuditLog, Run
from ..schemas import AuditEntry, AuditList, HealthOut, UsageByDay, UsageByProvider, UsageOut, UsageRow

router = APIRouter(tags=["service"])
log = logging.getLogger(__name__)


def _check_postgres() -> None:
    with SessionLocal() as db:
        db.execute(text("select 1"))


async def _check(name: str, fn) -> tuple[str, str]:
    try:
        await asyncio.wait_for(run_in_threadpool(fn), timeout=5)
        return name, "ok"
    except Exception as e:  # noqa: BLE001
        return name, f"error: {type(e).__name__}: {e}"[:200]


@router.get("/health", response_model=HealthOut)
async def health(svc: Svc) -> HealthOut:
    results = await asyncio.gather(
        _check("postgres", _check_postgres),
        _check("redis", svc.redis.ping),
        _check("qdrant", svc.vectors.ping),
        _check("s3", svc.store.ping),
        _check("embedder", svc.embedder.info),
    )
    checks = dict(results)
    status = "ok" if all(v == "ok" for v in checks.values()) else "degraded"
    s = get_settings()
    return HealthOut(status=status, version=s.agent_version, checks=checks, limits={"max_upload_mb": s.max_upload_mb})


def _add(row: UsageRow, usage: dict | None) -> None:
    row.runs += 1
    if not usage:
        return
    row.llm_calls += int(usage.get("llm_calls") or 0)
    row.prompt_tokens += int(usage.get("prompt_tokens") or 0)
    row.completion_tokens += int(usage.get("completion_tokens") or 0)
    row.cost_usd = round(row.cost_usd + float(usage.get("cost_usd") or 0.0), 6)
    row.duration_s = round(row.duration_s + float(usage.get("duration_s") or 0.0), 3)


@router.get("/usage", response_model=UsageOut)
def usage(_: CurrentUser, db: DB, from_: date | None = Query(None, alias="from"), to: date | None = None) -> UsageOut:
    """Расход по завершённым и упавшим прогонам за период (по дате создания, UTC, границы включительно)."""
    end = to or datetime.now(timezone.utc).date()
    start = from_ or (end - timedelta(days=30))
    lo = datetime.combine(start, time.min, tzinfo=timezone.utc)
    hi = datetime.combine(end + timedelta(days=1), time.min, tzinfo=timezone.utc)
    runs = db.execute(select(Run.provider, Run.model, Run.created_at, Run.usage)
                      .where(Run.created_at >= lo, Run.created_at < hi, Run.status.in_(["done", "failed"]))).all()
    totals = UsageRow()
    by_provider: dict[tuple[str, str], UsageByProvider] = {}
    by_day: dict[date, UsageByDay] = defaultdict(lambda: UsageByDay(date=start))
    for provider, model, created_at, u in runs:
        _add(totals, u)
        key = (provider, model)
        if key not in by_provider:
            by_provider[key] = UsageByProvider(provider=provider, model=model)
        _add(by_provider[key], u)
        day = created_at.astimezone(timezone.utc).date()
        if day not in by_day:
            by_day[day] = UsageByDay(date=day)
        _add(by_day[day], u)
    return UsageOut(totals=totals, by_provider=sorted(by_provider.values(), key=lambda r: -r.runs),
                    by_day=[by_day[d] for d in sorted(by_day)])


@router.get("/audit", response_model=AuditList)
def audit_log(_: CurrentUser, db: DB, limit: int = Query(50, ge=1, le=500), offset: int = Query(0, ge=0)) -> AuditList:
    total = db.scalar(select(func.count()).select_from(AuditLog)) or 0
    rows = db.scalars(select(AuditLog).order_by(AuditLog.id.desc()).limit(limit).offset(offset)).all()
    return AuditList(items=[AuditEntry(id=r.id, ts=r.ts, actor=r.actor, action=r.action, target=r.target,
                                       details=r.details or {}) for r in rows], total=total)
