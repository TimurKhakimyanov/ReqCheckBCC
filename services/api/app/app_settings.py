"""Настройки приложения в БД (одна строка app_settings): всё про ИИ задаётся в админке, а не в .env."""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field
from req_contracts import ProviderName
from sqlalchemy.orm import Session

from .db import SessionLocal
from .models import AppSettingsRow
from .security import decrypt_secret

SETTINGS_ID = 1
MAX_RUN_TIMEOUT_S = 6 * 3600  # visibility_timeout брокера рассчитан на этот потолок

EmbeddingsProvider = Literal["local", "gemini", "openai"]
DEFAULT_EMBEDDING_MODELS = {"local": None, "gemini": "gemini-embedding-001", "openai": "text-embedding-3-small"}


class AppSettings(BaseModel):
    """Хранится в app_settings.data (JSONB). Новые поля — с дефолтом, миграция данных не нужна."""

    default_provider: ProviderName = ProviderName.GEMINI
    default_model: str | None = None
    # прогон
    run_timeout_s: int = Field(default=1800, ge=60, le=MAX_RUN_TIMEOUT_S)
    min_interval_s: float = Field(default=0.0, ge=0, le=120)
    max_attempts: int = Field(default=6, ge=1, le=20)
    batch_size: int = Field(default=6, ge=1, le=50)
    concurrency: int = Field(default=1, ge=1, le=16)
    # эмбеддинги (ключ — отдельной зашифрованной колонкой)
    embeddings_provider: EmbeddingsProvider = "local"
    embeddings_model: str | None = None
    embeddings_dim: int | None = Field(default=None, ge=16, le=4096, description="Только для gemini (outputDimensionality)")
    # прочее
    max_upload_mb: int = Field(default=25, ge=1, le=500)
    session_ttl_hours: int = Field(default=12, ge=1, le=24 * 30)


@dataclass(frozen=True)
class EmbeddingConfig:
    provider: str
    model: str | None
    api_key: str | None
    dim: int | None

    @property
    def signature(self) -> str:
        return f"{self.provider}:{self.model or ''}:{self.dim or ''}"

    def request_fields(self) -> dict:
        if self.provider == "local":
            return {}
        return {"provider": self.provider, "model": self.model, "api_key": self.api_key, "dim": self.dim}


def load_row(db: Session) -> AppSettingsRow:
    row = db.get(AppSettingsRow, SETTINGS_ID)
    if row is None:
        row = AppSettingsRow(id=SETTINGS_ID, data=AppSettings().model_dump(mode="json"))
        db.add(row)
        db.flush()
    return row


def get_app_settings(db: Session) -> AppSettings:
    row = db.get(AppSettingsRow, SETTINGS_ID)
    return AppSettings.model_validate(row.data) if row else AppSettings()


def read_app_settings() -> AppSettings:
    with SessionLocal() as db:
        return get_app_settings(db)


def embedding_config_from(db: Session) -> EmbeddingConfig:
    row = db.get(AppSettingsRow, SETTINGS_ID)
    s = AppSettings.model_validate(row.data) if row else AppSettings()
    key = decrypt_secret(row.embeddings_api_key_encrypted) if row and row.embeddings_api_key_encrypted else None
    model = s.embeddings_model or DEFAULT_EMBEDDING_MODELS[s.embeddings_provider]
    dim = (s.embeddings_dim or 768) if s.embeddings_provider == "gemini" else None
    return EmbeddingConfig(provider=s.embeddings_provider, model=model, api_key=key, dim=dim)


class _Cached:
    """Короткий кеш конфигурации эмбеддингов: не ходить в БД на каждый вызов embedder."""

    def __init__(self, ttl_s: float = 5.0):
        self.ttl_s = ttl_s
        self._value: EmbeddingConfig | None = None
        self._at = 0.0
        self._lock = threading.Lock()

    def get(self) -> EmbeddingConfig:
        with self._lock:
            if self._value is None or time.monotonic() - self._at > self.ttl_s:
                with SessionLocal() as db:
                    self._value = embedding_config_from(db)
                self._at = time.monotonic()
            return self._value

    def invalidate(self) -> None:
        with self._lock:
            self._value = None


embedding_config = _Cached()


class SettingsOut(AppSettings):
    embeddings_has_key: bool = False
    embeddings_key_hint: str | None = None
    updated_at: datetime | None = None


class SettingsUpdate(BaseModel):
    """PUT /settings: передаются только изменяемые поля. embeddings_api_key: "" — удалить ключ."""

    default_provider: ProviderName | None = None
    default_model: str | None = None
    run_timeout_s: int | None = Field(default=None, ge=60, le=MAX_RUN_TIMEOUT_S)
    min_interval_s: float | None = Field(default=None, ge=0, le=120)
    max_attempts: int | None = Field(default=None, ge=1, le=20)
    batch_size: int | None = Field(default=None, ge=1, le=50)
    concurrency: int | None = Field(default=None, ge=1, le=16)
    embeddings_provider: EmbeddingsProvider | None = None
    embeddings_model: str | None = None
    embeddings_dim: int | None = Field(default=None, ge=16, le=4096)
    embeddings_api_key: str | None = None
    max_upload_mb: int | None = Field(default=None, ge=1, le=500)
    session_ttl_hours: int | None = Field(default=None, ge=1, le=24 * 30)
