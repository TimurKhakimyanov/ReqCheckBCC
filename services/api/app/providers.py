"""Настройки провайдеров LLM: хранение ключей и сборка ProviderConfig (используется API и воркером).

Источник истины — БД (кабинет администратора). Переменные окружения для ИИ не читаются.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from pydantic import SecretStr
from req_contracts import ProviderConfig, ProviderName
from sqlalchemy.orm import Session

from .app_settings import AppSettings, get_app_settings
from .config import PROVIDERS
from .models import ProviderSetting
from .security import decrypt_secret, encrypt_secret, key_hint

log = logging.getLogger(__name__)

# Подсказки, если провайдер недоступен или модель не выбрана. Для openai_compatible модель задаёт админ.
FALLBACK_MODELS: dict[str, list[str]] = {
    "gemini": ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.5-flash-lite"],
    "openai": ["gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini"],
    "anthropic": ["claude-sonnet-4-5", "claude-haiku-4-5", "claude-opus-4-1"],
    "openai_compatible": [],
}


class ProviderNotConfigured(Exception):
    pass


@dataclass
class Overrides:
    """Несохранённые значения из формы (POST /providers/{p}/test) поверх сохранённых."""

    api_key: str | None = None
    base_url: str | None = None
    extra_body: dict | None = None
    extra_body_set: bool = False  # extra_body передан явно (в т. ч. null — проверить без него)


def get_or_create(db: Session, provider: str) -> ProviderSetting:
    row = db.get(ProviderSetting, provider)
    if row is None:
        row = ProviderSetting(provider=provider, enabled=True)
        db.add(row)
        db.flush()
    return row


def set_api_key(row: ProviderSetting, api_key: str) -> None:
    if api_key:
        row.api_key_encrypted = encrypt_secret(api_key)
        row.key_hint = key_hint(api_key)
    else:
        row.api_key_encrypted = None
        row.key_hint = None


def seed_providers(db: Session) -> None:
    """Создаёт строки всех провайдеров (пустые: ключи и адреса вводятся в кабинете)."""
    for provider in PROVIDERS:
        get_or_create(db, provider)
    db.commit()


def is_configured(row: ProviderSetting | None) -> bool:
    """openai_compatible настроен, если задан адрес сервера (ключ необязателен); остальные — если есть ключ."""
    if row is None or not row.enabled:
        return False
    if row.provider == ProviderName.OPENAI_COMPATIBLE.value:
        return bool(row.base_url)
    return bool(row.api_key_encrypted)


def default_provider(db: Session) -> str:
    """Провайдер по умолчанию из настроек, если он настроен, иначе первый настроенный."""
    preferred = get_app_settings(db).default_provider.value
    rows = {r.provider: r for r in db.query(ProviderSetting).all()}
    if is_configured(rows.get(preferred)):
        return preferred
    for p in PROVIDERS:
        if is_configured(rows.get(p)):
            return p
    return preferred


def resolve_model(db: Session, provider: str, model: str | None, settings: AppSettings | None = None) -> str:
    if model:
        return model
    row = db.get(ProviderSetting, provider)
    if row and row.default_model:
        return row.default_model
    settings = settings or get_app_settings(db)
    if provider == settings.default_provider.value and settings.default_model:
        return settings.default_model
    fallback = FALLBACK_MODELS.get(provider) or []
    if fallback:
        return fallback[0]
    raise ProviderNotConfigured(f"Не указана модель для провайдера {provider}. Выберите модель в настройках")


def build_provider_config(db: Session, provider: str, model: str | None = None, *, require_enabled: bool = True,
                          overrides: Overrides | None = None, require_model: bool = True) -> ProviderConfig:
    if provider not in PROVIDERS:
        raise ProviderNotConfigured(f"Неизвестный провайдер: {provider}")
    row = db.get(ProviderSetting, provider) or get_or_create(db, provider)
    if require_enabled and not row.enabled:
        raise ProviderNotConfigured(f"Провайдер {provider} отключён в настройках")
    settings = get_app_settings(db)

    api_key: str | None
    if overrides and overrides.api_key is not None:
        api_key = overrides.api_key.strip() or None
    elif row.api_key_encrypted:
        api_key = decrypt_secret(row.api_key_encrypted)
        if api_key is None:
            raise ProviderNotConfigured(
                f"Не удалось расшифровать ключ {provider}: сменился APP_ENCRYPTION_KEY? Задайте ключ заново")
    else:
        api_key = None
    base_url = (overrides.base_url.strip() if overrides and overrides.base_url is not None else row.base_url) or None

    if provider == ProviderName.OPENAI_COMPATIBLE.value:
        if not base_url:
            raise ProviderNotConfigured("Укажите адрес OpenAI-совместимого сервера (base_url), например http://vllm.example.local:8000/v1")
    elif not api_key:
        raise ProviderNotConfigured(f"Не задан API-ключ провайдера {provider}. Укажите его в настройках")

    try:
        resolved = resolve_model(db, provider, model, settings)
    except ProviderNotConfigured:
        if require_model:
            raise
        resolved = ""
    return ProviderConfig(
        provider=ProviderName(provider),
        model=resolved,
        api_key=SecretStr(api_key) if api_key else None,
        base_url=base_url,
        min_interval_s=settings.min_interval_s,
        max_attempts=settings.max_attempts,
        max_output_tokens=row.max_output_tokens,
        **({"timeout_s": float(row.timeout_s)} if row.timeout_s else {}),
        extra_body=overrides.extra_body if overrides and overrides.extra_body_set else row.extra_body,
        extra_body_set_review=row.extra_body_set_review,
    )
