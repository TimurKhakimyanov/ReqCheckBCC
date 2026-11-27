from __future__ import annotations

from fastapi import APIRouter, BackgroundTasks, Request

from ..app_settings import AppSettings, SettingsOut, SettingsUpdate, embedding_config, load_row
from ..audit import audit
from ..deps import DB, CurrentUser, Svc
from ..knowledge import reindex_all
from ..schemas import ErrorOut
from ..security import encrypt_secret, key_hint

router = APIRouter(prefix="/settings", tags=["settings"])
EMBEDDING_FIELDS = {"embeddings_provider", "embeddings_model", "embeddings_dim", "embeddings_api_key"}


def settings_out(row) -> SettingsOut:
    return SettingsOut(**AppSettings.model_validate(row.data).model_dump(), embeddings_has_key=bool(
        row.embeddings_api_key_encrypted), embeddings_key_hint=row.embeddings_key_hint, updated_at=row.updated_at)


@router.get("", response_model=SettingsOut)
def read_settings(_: CurrentUser, db: DB) -> SettingsOut:
    row = load_row(db)
    db.commit()
    return settings_out(row)


@router.put("", response_model=SettingsOut, responses={422: {"model": ErrorOut}})
def update_settings(body: SettingsUpdate, request: Request, background: BackgroundTasks, user: CurrentUser, db: DB,
                    svc: Svc) -> SettingsOut:
    row = load_row(db)
    current = AppSettings.model_validate(row.data)
    changes = body.model_dump(exclude_unset=True)
    key = changes.pop("embeddings_api_key", None)
    # null в необязательных строковых полях означает «сбросить», в числовых — «не менять»
    for nullable in ("default_model", "embeddings_model", "embeddings_dim"):
        if nullable in changes and changes[nullable] in ("", None):
            changes[nullable] = None
    changes = {k: v for k, v in changes.items() if v is not None or k in ("default_model", "embeddings_model",
                                                                          "embeddings_dim")}
    updated = AppSettings.model_validate({**current.model_dump(mode="json"), **changes})
    row.data = updated.model_dump(mode="json")
    if key is not None:
        key = key.strip()
        row.embeddings_api_key_encrypted = encrypt_secret(key) if key else None
        row.embeddings_key_hint = key_hint(key) if key else None
    fields = sorted(set(changes) | ({"embeddings_api_key"} if key is not None else set()))
    audit(db, user.username, "settings_updated", None, {"fields": fields}, request, commit=False)
    db.commit()
    embeddings_changed = (
        (current.embeddings_provider, current.embeddings_model, current.embeddings_dim)
        != (updated.embeddings_provider, updated.embeddings_model, updated.embeddings_dim)
        or (key is not None and updated.embeddings_provider != "local")
    )
    embedding_config.invalidate()
    if embeddings_changed:
        # Другая модель — другие векторы: коллекции пересоздаются, база знаний и отчёты индексируются заново.
        background.add_task(reindex_all, svc)
    return settings_out(row)
