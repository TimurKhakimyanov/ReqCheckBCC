"""Общие зависимости FastAPI."""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import Depends, Request
from sqlalchemy.orm import Session

from .db import get_db
from .errors import ApiError, not_found
from .models import User
from .security import COOKIE_NAME, decode_session_token
from .services import Services, get_services

DB = Annotated[Session, Depends(get_db)]


def current_user(request: Request, db: DB) -> User:
    token = request.cookies.get(COOKIE_NAME)
    payload = decode_session_token(token) if token else None
    if not payload:
        raise ApiError(401, "unauthorized", "Требуется вход")
    try:
        user = db.get(User, uuid.UUID(payload["sub"]))
    except (KeyError, ValueError):
        user = None
    if user is None:
        raise ApiError(401, "unauthorized", "Сессия недействительна")
    return user


CurrentUser = Annotated[User, Depends(current_user)]
Svc = Annotated[Services, Depends(get_services)]


def parse_uuid(value: str, what: str = "Объект") -> uuid.UUID:
    try:
        return uuid.UUID(value)
    except ValueError:
        raise not_found(what) from None
