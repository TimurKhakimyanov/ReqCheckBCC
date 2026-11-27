"""Пароли (argon2), JWT-сессия в cookie, шифрование ключей провайдеров (Fernet)."""

from __future__ import annotations

import base64
import hashlib
import logging
import uuid
from datetime import datetime, timedelta, timezone
from functools import lru_cache

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError
from cryptography.fernet import Fernet, InvalidToken

from .config import get_settings

log = logging.getLogger(__name__)
_hasher = PasswordHasher()
COOKIE_NAME = "session"
JWT_ALG = "HS256"


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return _hasher.verify(password_hash, password)
    except (VerificationError, InvalidHashError):
        return False


def create_session_token(user_id: uuid.UUID, username: str) -> str:
    s = get_settings()
    now = datetime.now(timezone.utc)
    payload = {"sub": str(user_id), "name": username, "iat": now, "exp": now + timedelta(hours=s.session_ttl_hours)}
    return jwt.encode(payload, s.app_secret_key, algorithm=JWT_ALG)


def decode_session_token(token: str) -> dict | None:
    try:
        return jwt.decode(token, get_settings().app_secret_key, algorithms=[JWT_ALG])
    except jwt.PyJWTError:
        return None


@lru_cache
def _fernet() -> Fernet:
    raw = get_settings().app_encryption_key
    try:
        return Fernet(raw.encode())
    except (ValueError, TypeError):
        # Не ключ Fernet (например, change-me) — выводим ключ из строки, чтобы сервис поднялся.
        log.warning("APP_ENCRYPTION_KEY is not a Fernet key; deriving one. Generate a real key: python -m app.keygen")
        return Fernet(base64.urlsafe_b64encode(hashlib.sha256(raw.encode()).digest()))


def encrypt_secret(value: str) -> str:
    return _fernet().encrypt(value.encode()).decode()


def decrypt_secret(token: str) -> str | None:
    try:
        return _fernet().decrypt(token.encode()).decode()
    except InvalidToken:
        log.error("cannot decrypt provider key: APP_ENCRYPTION_KEY changed?")
        return None


def key_hint(value: str) -> str:
    return "…" + value[-4:] if len(value) >= 8 else "…"
