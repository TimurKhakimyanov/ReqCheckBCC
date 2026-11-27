"""Настройки провайдеров LLM: хранение ключей и сборка ProviderConfig (используется API и воркером)."""

from __future__ import annotations

import logging

from pydantic import SecretStr
from req_contracts import ProviderConfig, ProviderName
from sqlalchemy.orm import Session

from .config import PROVIDERS, get_settings
from .models import ProviderSetting
from .security import decrypt_secret, encrypt_secret, key_hint

log = logging.getLogger(__name__)

# Подсказки для выпадающего списка, если провайдер недоступен или ядро ещё не умеет list_models.
FALLBACK_MODELS: dict[str, list[str]] = {
    "gemini": ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.5-flash-lite"],
    "openai": ["gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini"],
    "anthropic": ["claude-sonnet-4-5", "claude-haiku-4-5", "claude-opus-4-1"],
    "openai_compatible": [],
}


class ProviderNotConfigured(Exception):
    pass


def get_or_create(db: Session, provider: str) -> ProviderSetting:
    row = db.get(ProviderSetting, provider)
    if row is None:
        row = ProviderSetting(provider=provider, enabled=True)
        if provider == "openai_compatible":
            row.base_url = get_settings().openai_compatible_base_url
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
    """Создаёт строки провайдеров; ключи из .env записываются, только если в кабинете ключа ещё нет."""
    s = get_settings()
    for provider in PROVIDERS:
        row = get_or_create(db, provider)
        initial = s.initial_key(provider)
        if initial and not row.api_key_encrypted:
            set_api_key(row, initial)
            log.info("seeded provider key from environment", extra={"provider": provider})
        if provider == "openai_compatible" and not row.default_model and s.openai_compatible_model:
            row.default_model = s.openai_compatible_model
        if provider == s.default_llm_provider and not row.default_model and s.default_llm_model:
            row.default_model = s.default_llm_model
    db.commit()


def default_provider(db: Session) -> str:
    """Провайдер по умолчанию: из настроек, если он настроен, иначе первый с ключом."""
    s = get_settings()
    rows = {r.provider: r for r in db.query(ProviderSetting).all()}

    def usable(p: str) -> bool:
        r = rows.get(p)
        return bool(r and r.enabled and (r.api_key_encrypted or p == "openai_compatible"))

    if s.default_llm_provider in PROVIDERS and usable(s.default_llm_provider):
        return s.default_llm_provider
    for p in PROVIDERS:
        if p != "openai_compatible" and usable(p):
            return p
    return s.default_llm_provider if s.default_llm_provider in PROVIDERS else "gemini"


def resolve_model(db: Session, provider: str, model: str | None) -> str:
    if model:
        return model
    row = db.get(ProviderSetting, provider)
    if row and row.default_model:
        return row.default_model
    s = get_settings()
    if provider == s.default_llm_provider and s.default_llm_model:
        return s.default_llm_model
    fallback = FALLBACK_MODELS.get(provider) or []
    if fallback:
        return fallback[0]
    raise ProviderNotConfigured(f"Не указана модель для провайдера {provider}")


def build_provider_config(db: Session, provider: str, model: str | None = None,
                          *, require_enabled: bool = True) -> ProviderConfig:
    if provider not in PROVIDERS:
        raise ProviderNotConfigured(f"Неизвестный провайдер: {provider}")
    row = db.get(ProviderSetting, provider)
    if row is None:
        row = get_or_create(db, provider)
    if require_enabled and not row.enabled:
        raise ProviderNotConfigured(f"Провайдер {provider} отключён в настройках")
    api_key = decrypt_secret(row.api_key_encrypted) if row.api_key_encrypted else None
    if row.api_key_encrypted and api_key is None:
        raise ProviderNotConfigured(f"Не удалось расшифровать ключ {provider}: сменился APP_ENCRYPTION_KEY? Задайте ключ заново")
    if not api_key and provider != "openai_compatible":
        raise ProviderNotConfigured(f"Не задан API-ключ провайдера {provider}. Укажите его в настройках")
    base_url = row.base_url or (get_settings().openai_compatible_base_url if provider == "openai_compatible" else None)
    return ProviderConfig(
        provider=ProviderName(provider),
        model=resolve_model(db, provider, model),
        api_key=SecretStr(api_key) if api_key else None,
        base_url=base_url,
    )
