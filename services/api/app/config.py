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
    session_ttl_hours: int = 12
    cookie_secure: bool = False

    max_upload_mb: int = 25
    run_timeout_s: int = 1800

    default_llm_provider: str = "gemini"
    default_llm_model: str = ""
    openai_compatible_base_url: str = "http://ollama:11434/v1"
    # Начальные ключи провайдеров: записываются в кабинет при старте, если там ключа ещё нет.
    gemini_api_key: str = ""
    openai_api_key: str = ""
    anthropic_api_key: str = ""
    openai_compatible_api_key: str = ""
    openai_compatible_model: str = ""

    @property
    def is_test(self) -> bool:
        return self.app_env == "test"

    def initial_key(self, provider: str) -> str:
        return getattr(self, f"{provider}_api_key", "") or ""


@lru_cache
def get_settings() -> Settings:
    return Settings()
