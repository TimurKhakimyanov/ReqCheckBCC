from __future__ import annotations

import os

os.environ["APP_ENV"] = "test"

import pytest  # noqa: E402
import req_core  # noqa: E402
from app import testing  # noqa: E402

testing.prepare_test_database("api_test")

from app.services import set_services  # noqa: E402
from asgi_lifespan import LifespanManager  # noqa: E402
from httpx import ASGITransport, AsyncClient  # noqa: E402

ADMIN = {"username": os.environ.get("ADMIN_USERNAME", "admin"), "password": os.environ.get("ADMIN_PASSWORD", "test-password")}


@pytest.fixture(scope="session", autouse=True)
def mock_core():
    """Ядро пока заглушка: подменяем функции моками на sample_report.json."""
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(req_core, "answer_question", testing.fake_answer_question)
        mp.setattr(req_core, "render_report", testing.fake_render_report)
        mp.setattr(req_core, "list_models", lambda cfg: ["model-b", "model-a"])
        yield


@pytest.fixture(scope="session")
def services():
    svc = testing.RecordingServices(os.environ["REDIS_URL"])
    set_services(svc)
    yield svc
    set_services(None)


@pytest.fixture(scope="session")
async def api_app(services):
    from app.main import create_app

    application = create_app()
    async with LifespanManager(application):
        yield application


@pytest.fixture(scope="session")
async def anon(api_app):
    async with AsyncClient(transport=ASGITransport(app=api_app), base_url="http://test") as c:
        yield c


@pytest.fixture(scope="session")
async def client(api_app):
    async with AsyncClient(transport=ASGITransport(app=api_app), base_url="http://test") as c:
        r = await c.post("/api/auth/login", json=ADMIN)
        assert r.status_code == 200, r.text
        yield c
