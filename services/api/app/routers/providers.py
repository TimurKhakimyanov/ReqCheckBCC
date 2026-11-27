from __future__ import annotations

import asyncio
import time

import req_core
from fastapi import APIRouter, Request
from req_contracts import ProviderName
from starlette.concurrency import run_in_threadpool

from ..audit import audit
from ..config import PROVIDERS
from ..deps import DB, CurrentUser
from ..errors import ApiError
from ..models import ProviderSetting
from ..providers import FALLBACK_MODELS, ProviderNotConfigured, build_provider_config, get_or_create, set_api_key
from ..schemas import ErrorOut, ModelsOut, ProviderOut, ProviderTestOut, ProviderUpdate

router = APIRouter(prefix="/providers", tags=["providers"])


def provider_out(row: ProviderSetting) -> ProviderOut:
    return ProviderOut(provider=ProviderName(row.provider), enabled=row.enabled, has_key=bool(row.api_key_encrypted),
                       key_hint=row.key_hint, base_url=row.base_url, default_model=row.default_model,
                       updated_at=row.updated_at)


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
    audit(db, user.username, "provider_updated", provider.value, {"fields": changed}, request, commit=False)
    db.commit()
    return provider_out(row)


@router.post("/{provider}/test", response_model=ProviderTestOut, responses={400: {"model": ErrorOut}})
async def test_provider(provider: ProviderName, _: CurrentUser, db: DB) -> ProviderTestOut:
    try:
        cfg = await run_in_threadpool(build_provider_config, db, provider.value, None, require_enabled=False)
    except ProviderNotConfigured as e:
        return ProviderTestOut(ok=False, latency_ms=0, error=str(e))
    cfg = cfg.model_copy(update={"timeout_s": 30.0, "max_output_tokens": 16})
    start = time.perf_counter()
    try:
        client = req_core.get_llm(cfg)
        await asyncio.wait_for(run_in_threadpool(client.complete, "Answer with one word.", "ping"), timeout=40)
    except NotImplementedError:
        return ProviderTestOut(ok=False, latency_ms=0, error="Ядро агента ещё не поддерживает этот провайдер")
    except TimeoutError:
        return ProviderTestOut(ok=False, latency_ms=int((time.perf_counter() - start) * 1000), error="Таймаут")
    except Exception as e:  # noqa: BLE001 — показываем любую ошибку провайдера пользователю
        return ProviderTestOut(ok=False, latency_ms=int((time.perf_counter() - start) * 1000),
                               error=f"{type(e).__name__}: {e}"[:500])
    return ProviderTestOut(ok=True, latency_ms=int((time.perf_counter() - start) * 1000))


@router.get("/{provider}/models", response_model=ModelsOut)
async def provider_models(provider: ProviderName, _: CurrentUser, db: DB) -> ModelsOut:
    fallback = list(FALLBACK_MODELS.get(provider.value, []))
    row = db.get(ProviderSetting, provider.value)
    if row is not None and row.default_model and row.default_model not in fallback:
        fallback.insert(0, row.default_model)
    try:
        cfg = await run_in_threadpool(build_provider_config, db, provider.value, fallback[0] if fallback else "-",
                                      require_enabled=False)
        models = await asyncio.wait_for(run_in_threadpool(req_core.list_models, cfg), timeout=20)
        if not models:
            raise ApiError(502, "no_models", "Провайдер не вернул список моделей")
        return ModelsOut(models=sorted(set(models)))
    except NotImplementedError:
        return ModelsOut(models=fallback, error="Список моделей недоступен: ядро не поддерживает запрос")
    except ProviderNotConfigured as e:
        return ModelsOut(models=fallback, error=str(e))
    except Exception as e:  # noqa: BLE001
        detail = e.detail if isinstance(e, ApiError) else f"{type(e).__name__}: {e}"
        return ModelsOut(models=fallback, error=str(detail)[:500])
