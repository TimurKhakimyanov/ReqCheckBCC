"""ReqCheck API (FastAPI). OpenAPI: /api/openapi.json, Swagger UI: /api/docs."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Response
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError

from .app_settings import load_row
from .config import get_settings
from .db import SessionLocal
from .errors import install_error_handlers
from .knowledge import start_builtin_indexer
from .logging_setup import setup_logging
from .metrics import MetricsMiddleware
from .models import User
from .providers import seed_providers
from .routers import auth, chat, documents, knowledge, providers, runs, settings, system
from .security import hash_password
from .services import get_services

log = logging.getLogger("app")


def bootstrap() -> None:
    """Единственный админ из ADMIN_USERNAME/ADMIN_PASSWORD (пароль потом меняется в кабинете), строки провайдеров
    и настроек. Ключи и модели ИИ из окружения не читаются — только из кабинета."""
    s = get_settings()
    with SessionLocal() as db:
        user = db.scalar(select(User).where(User.username == s.admin_username))
        if user is None:
            if not s.admin_password or s.admin_password == "change-me":
                log.warning("ADMIN_PASSWORD is empty or default; set a strong password in .env")
            db.add(User(username=s.admin_username, password_hash=hash_password(s.admin_password or "change-me"),
                        role="admin", locale="ru"))
            db.commit()
            log.info("admin user created", extra={"username": s.admin_username})
        seed_providers(db)
        load_row(db)  # строка настроек приложения (дефолты), если миграция её не создала
        db.commit()


@asynccontextmanager
async def lifespan(app: FastAPI):
    s = get_settings()
    setup_logging("api", s.log_level)
    if len(s.app_secret_key) < 32 or s.app_secret_key == "change-me":
        log.warning("APP_SECRET_KEY is short or default; generate one: python -m app.keygen")
    try:
        bootstrap()
    except SQLAlchemyError:
        log.exception("bootstrap failed: did migrations run? (service migrate: alembic upgrade head)")
        raise
    svc = get_services()
    try:
        svc.store.ensure_bucket()
    except Exception:  # noqa: BLE001 — хранилище может стартовать позже; бакет создастся при первой записи
        log.warning("s3 bucket check failed at startup", exc_info=True)
    if not s.is_test:
        start_builtin_indexer(svc)
    log.info("api started", extra={"version": s.agent_version})
    yield


def create_app() -> FastAPI:
    app = FastAPI(
        title="ReqCheck API", version="1.0.0", lifespan=lifespan,
        openapi_url="/api/openapi.json", docs_url="/api/docs", redoc_url=None,
        description="HTTP API ReqCheck — агент проверки требований (ISO/IEC/IEEE 29148, IEEE 830). "
                    "Авторизация: httpOnly cookie `session` после POST /api/auth/login.",
    )
    install_error_handlers(app)
    app.add_middleware(MetricsMiddleware)
    for r in (auth.router, settings.router, providers.router, documents.router, runs.router, chat.router, knowledge.router,
              system.router):
        app.include_router(r, prefix="/api")

    @app.get("/metrics", include_in_schema=False)
    def metrics() -> Response:
        return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)

    @app.get("/livez", include_in_schema=False)
    def livez() -> dict:
        return {"status": "ok"}

    return app


app = create_app()
