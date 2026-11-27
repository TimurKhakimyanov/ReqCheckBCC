"""Настройки сервиса из переменных окружения (см. .env.example, раздел «Бэкенд»)."""

from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict

PROVIDERS = ("gemini", "openai", "anthropic", "openai_compatible")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=None, extra="ignore")

    app_env: str = "production"
    log_level: str = "INFO"
    agent_version: str = "dev"

    database_url: str = "postgresql+psycopg://reqcheck:reqcheck@postgres:5432/reqcheck"
    redis_url: str = "redis://redis:6379/0"
    qdrant_url: str = "http://qdrant:6333"
    qdrant_api_key: str | None = None
    s3_endpoint_url: str = "http://seaweedfs:8333"
    s3_access_key: str = ""
    s3_secret_key: str = ""
    s3_bucket: str = "reqcheck"
    s3_region: str = "us-east-1"
    embedder_url: str = "http://embedder:8001"

    app_secret_key: str = "change-me"
    app_encryption_key: str = "change-me"
    admin_username: str = "admin"
    admin_password: str = ""
    # Secure-флаг cookie зависит от TLS на хосте, поэтому остаётся в окружении.
    # Всё про ИИ (провайдеры, ключи, модели, таймауты, эмбеддинги) — в админке: app/app_settings.py.
    cookie_secure: bool = False

    @property
    def is_test(self) -> bool:
        return self.app_env == "test"


@lru_cache
def get_settings() -> Settings:
    return Settings()
