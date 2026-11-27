"""Простой журнал аудита действий пользователя."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import Request
from sqlalchemy.orm import Session

from .models import AuditLog

log = logging.getLogger("audit")


def client_ip(request: Request | None) -> str | None:
    if request is None:
        return None
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else None


def audit(db: Session, actor: str, action: str, target: str | None = None, details: dict[str, Any] | None = None,
          request: Request | None = None, *, commit: bool = True) -> None:
    db.add(AuditLog(actor=actor, action=action, target=target, details=details or {}, ip=client_ip(request)))
    if commit:
        db.commit()
    log.info("audit", extra={"actor": actor, "action": action, "target": target})
