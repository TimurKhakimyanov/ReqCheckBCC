from __future__ import annotations

import asyncio
import time

import req_core
from fastapi import APIRouter, Request
from req_contracts import ProviderConfig, ProviderName
from starlette.concurrency import run_in_threadpool

from ..audit import audit
from ..config import PROVIDERS
from ..deps import DB, CurrentUser
from ..models import ProviderSetting
from ..providers import (
    FALLBACK_MODELS,
    Overrides,
    ProviderNotConfigured,
    build_provider_config,
    get_or_create,
    set_api_key,
)
from ..schemas import ModelsOut, ProviderOut, ProviderTestIn, ProviderTestOut, ProviderUpdate

router = APIRouter(prefix="/providers", tags=["providers"])


def provider_out(row: ProviderSetting) -> ProviderOut:
    return ProviderOut(provider=ProviderName(row.provider), enabled=row.enabled, has_key=bool(row.api_key_encrypted),
                       key_hint=row.key_hint, base_url=row.base_url, default_model=row.default_model,
                       extra_body=row.extra_body, extra_body_set_review=row.extra_body_set_review,
                       max_output_tokens=row.max_output_tokens, timeout_s=row.timeout_s, updated_at=row.updated_at)


@router.get("", response_model=list[ProviderOut])
def list_providers(_: CurrentUser, db: DB) -> list[ProviderOut]:
    rows = [get_or_create(db, p) for p in PROVIDERS]
    db.commit()
    return [provider_out(r) for r in rows]


@router.put("/{provider}", response_model=ProviderOut)
def update_provider(provider: ProviderName, body: ProviderUpdate, request: Request, user: CurrentUser,
                    db: DB) -> ProviderOut:
    row = get_or_create(db, provider.value)
    changed = []
    if body.api_key is not None:
        set_api_key(row, body.api_key.strip())
        changed.append("api_key_removed" if not body.api_key.strip() else "api_key")
    if body.base_url is not None:
        row.base_url = body.base_url.strip() or None
        changed.append("base_url")
    if body.enabled is not None:
        row.enabled = body.enabled
        changed.append("enabled")
    if body.default_model is not None:
        row.default_model = body.default_model.strip() or None
        changed.append("default_model")
    for field in ("extra_body", "extra_body_set_review", "max_output_tokens", "timeout_s"):
        if field in body.model_fields_set:  # null — сбросить
            setattr(row, field, getattr(body, field))
            changed.append(field)
    audit(db, user.username, "provider_updated", provider.value, {"fields": changed}, request, commit=False)
    db.commit()
    return provider_out(row)


def _ms(start: float) -> int:
    return int((time.perf_counter() - start) * 1000)


def _error_text(e: Exception) -> str:
    if isinstance(e, NotImplementedError):
        return "Ядро агента ещё не поддерживает этот запрос"
    if isinstance(e, TimeoutError):
        return "Таймаут ответа провайдера"
    return f"{type(e).__name__}: {e}"[:500]


async def _live_models(cfg: ProviderConfig) -> tuple[list[str], str | None]:
    """Живой список моделей через ядро (`req_core.list_models`)."""
    try:
        models = await asyncio.wait_for(run_in_threadpool(req_core.list_models, cfg), timeout=20)
    except Exception as e:  # noqa: BLE001 — ошибку показываем в админке
        return [], _error_text(e)
    models = sorted({m for m in models if m})
    return models, None if models else "Провайдер не вернул ни одной модели"


@router.post("/{provider}/test", response_model=ProviderTestOut)
async def test_provider(provider: ProviderName, _: CurrentUser, db: DB,
                        body: ProviderTestIn | None = None) -> ProviderTestOut:
    """Проверка ключа/адреса: список моделей и короткий запрос к модели. Значения из тела не сохраняются."""
    overrides = Overrides(api_key=body.api_key, base_url=body.base_url, extra_body=body.extra_body,
                          extra_body_set=body is not None and "extra_body" in body.model_fields_set) if body else None
    try:
        cfg = await run_in_threadpool(lambda: build_provider_config(
            db, provider.value, None, require_enabled=False, overrides=overrides, require_model=False))
    except ProviderNotConfigured as e:
        return ProviderTestOut(ok=False, latency_ms=0, error=str(e))
    # Проверка должна быть быстрой: без повторов и пауз; лимит токенов выбирает ядро (модели с рассуждениями).
    cfg = cfg.model_copy(update={"max_attempts": 1, "min_interval_s": 0.0})
    start = time.perf_counter()
    models, list_error = await _live_models(cfg)
    model = cfg.model or (models[0] if models else "")
    if not model:
        return ProviderTestOut(ok=False, latency_ms=_ms(start), models=models,
                               error=list_error or "Не выбрана модель для проверки")
    try:
        client = req_core.get_llm(cfg.model_copy(update={"model": model}))
        await asyncio.wait_for(run_in_threadpool(client.complete, "Answer with one word.", "ping"),
                               timeout=cfg.timeout_s + 15)
    except Exception as e:  # noqa: BLE001
        return ProviderTestOut(ok=False, latency_ms=_ms(start), models=models, error=_error_text(e))
    return ProviderTestOut(ok=True, latency_ms=_ms(start), models=models)


@router.get("/{provider}/models", response_model=ModelsOut)
async def provider_models(provider: ProviderName, _: CurrentUser, db: DB) -> ModelsOut:
    """Живой список моделей с сохранёнными ключом и адресом; при ошибке — подсказки и текст ошибки."""
    fallback = list(FALLBACK_MODELS.get(provider.value, []))
    row = db.get(ProviderSetting, provider.value)
    if row is not None and row.default_model and row.default_model not in fallback:
        fallback.insert(0, row.default_model)
    try:
        cfg = await run_in_threadpool(lambda: build_provider_config(
            db, provider.value, None, require_enabled=False, require_model=False))
    except ProviderNotConfigured as e:
        return ModelsOut(models=fallback, error=str(e))
    models, error = await _live_models(cfg.model_copy(update={"timeout_s": 20.0, "max_attempts": 1}))
    return ModelsOut(models=models, error=None) if models else ModelsOut(models=fallback, error=error)
