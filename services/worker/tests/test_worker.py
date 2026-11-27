"""Воркер: настоящие Postgres и Redis, S3/Qdrant в памяти, ядро — мок на sample_report.json."""

from __future__ import annotations

import os

os.environ["APP_ENV"] = "test"

import threading  # noqa: E402
import time  # noqa: E402
import uuid  # noqa: E402

import pytest  # noqa: E402
import req_core  # noqa: E402
from app import testing  # noqa: E402

testing.prepare_test_database("worker_test")

from app.config import get_settings  # noqa: E402
from app.db import SessionLocal  # noqa: E402
from app.models import Document, ProviderSetting, ReportRow, Run  # noqa: E402
from app.providers import set_api_key  # noqa: E402
from app.services import run_cancel_key, run_events_channel, set_services  # noqa: E402
from app.vectors import REQUIREMENTS  # noqa: E402
from req_contracts import ProgressEvent, Report, RunStage  # noqa: E402
from worker.celery_app import celery  # noqa: E402
from worker.tasks import describe_error, run_validation  # noqa: E402

SAMPLE = Report.model_validate(testing.sample_report_dict())


@pytest.fixture(scope="session")
def svc():
    s = testing.RecordingServices(os.environ["REDIS_URL"])
    set_services(s)
    celery.conf.task_always_eager = True
    with SessionLocal() as db:
        row = ProviderSetting(provider="gemini", enabled=True)
        set_api_key(row, "test-key-123456789")
        db.add(row)
        db.commit()
    yield s
    set_services(None)


@pytest.fixture(autouse=True)
def fake_render(monkeypatch):
    monkeypatch.setattr(req_core, "render_report", testing.fake_render_report)


def make_run(svc, provider: str = "gemini") -> str:
    doc_id = uuid.uuid4()
    key = f"documents/{doc_id}/requirements.md"
    svc.store.put(key, SAMPLE.document.text.encode())
    with SessionLocal() as db:
        db.add(Document(id=doc_id, name="requirements.md", format="md", size_bytes=1, sha256="x", s3_key=key))
        run = Run(document_id=doc_id, provider=provider, model="gemini-2.5-flash", options={"verify_pass": True},
                  status="queued", stage="queued", progress=0.0, message="")
        db.add(run)
        db.commit()
        return str(run.id)


def get_run(run_id: str) -> Run:
    with SessionLocal() as db:
        return db.get(Run, uuid.UUID(run_id))


class EventCollector:
    def __init__(self, svc, run_id: str):
        self.pubsub = svc.redis.pubsub()
        self.pubsub.subscribe(run_events_channel(run_id))
        self.pubsub.get_message(timeout=1)  # подтверждение подписки

    def events(self) -> list[ProgressEvent]:
        out = []
        while msg := self.pubsub.get_message(ignore_subscribe_messages=True, timeout=0.2):
            out.append(ProgressEvent.model_validate_json(msg["data"]))
        self.pubsub.close()
        return out


def fake_validate(path, llm, *, options=None, on_progress=None, document_name=None):
    assert path.read_text(encoding="utf-8") == SAMPLE.document.text
    assert llm.api_key.get_secret_value() == "test-key-123456789"
    assert options.verify_pass is True and document_name == "requirements.md"
    for i, stage in enumerate([RunStage.PARSING, RunStage.CHECKING_REQUIREMENTS, RunStage.CHECKING_SET,
                               RunStage.DONE]):
        on_progress(ProgressEvent(stage=stage, progress=(i + 1) / 4, message=stage.value))
    return SAMPLE


def test_successful_run(svc, monkeypatch):
    monkeypatch.setattr(req_core, "validate_document", fake_validate)
    run_id = make_run(svc)
    events = EventCollector(svc, run_id)
    assert run_validation.delay(run_id).get() == "done"

    run = get_run(run_id)
    assert run.status == "done" and run.progress == 1.0 and run.error is None and run.finished_at
    assert run.summary["findings_total"] == SAMPLE.summary.findings_total
    with SessionLocal() as db:
        row = db.get(ReportRow, uuid.UUID(run_id))
        assert Report.model_validate(row.data) == SAMPLE
        assert set(row.artifacts) == {"md", "docx", "pdf"}
    for fmt in ("md", "docx", "pdf"):
        assert svc.store.exists(f"reports/{run_id}/report.{fmt}")

    evs = events.events()
    stages = [e.stage for e in evs]
    assert stages[-1] == RunStage.DONE and stages.count(RunStage.DONE) == 1  # «done» ядра не пересылается
    assert all(a.progress <= b.progress for a, b in zip(evs, evs[1:], strict=False))
    assert all(e.run_id == run_id for e in evs)

    hits = svc.vectors.search(REQUIREMENTS, SAMPLE.findings[0].title, limit=50, filters={"run_id": run_id})
    kinds = {h.payload["kind"] for h in hits}
    assert kinds == {"requirement", "finding"}
    assert len(hits) == len(SAMPLE.requirements) + len(SAMPLE.findings)


def test_core_stub_gives_clear_error(svc):
    """Настоящая заглушка ядра (NotImplementedError) → понятная ошибка, а не трейсбек."""
    run_id = make_run(svc)
    events = EventCollector(svc, run_id)
    assert run_validation.delay(run_id).get() == "failed"
    run = get_run(run_id)
    assert run.status == "failed" and "Ядро агента ещё не реализовано" in run.error
    assert events.events()[-1].stage == RunStage.FAILED


def test_provider_error_is_explained(svc, monkeypatch):
    class AuthenticationError(Exception):
        pass

    def boom(*a, **k):
        raise AuthenticationError("Error code: 401 - invalid api key")

    monkeypatch.setattr(req_core, "validate_document", boom)
    run_id = make_run(svc)
    run_validation.delay(run_id).get()
    assert "отклонил ключ" in get_run(run_id).error


def test_provider_not_configured(svc):
    run_id = make_run(svc, provider="anthropic")
    assert run_validation.delay(run_id).get() == "failed"
    assert "Не задан API-ключ провайдера anthropic" in get_run(run_id).error


def test_cancel_during_run(svc, monkeypatch):
    def slow(path, llm, *, options=None, on_progress=None, document_name=None):
        for i in range(100):
            on_progress(ProgressEvent(stage=RunStage.CHECKING_REQUIREMENTS, progress=i / 100))
            time.sleep(0.05)
        return SAMPLE

    monkeypatch.setattr(req_core, "validate_document", slow)
    run_id = make_run(svc)

    def cancel_like_api():
        time.sleep(0.5)
        svc.redis.set(run_cancel_key(run_id), "1")
        with SessionLocal() as db:
            run = db.get(Run, uuid.UUID(run_id))
            run.status = run.stage = "cancelled"
            db.commit()

    threading.Thread(target=cancel_like_api).start()
    assert run_validation.delay(run_id).get() == "cancelled"
    assert get_run(run_id).status == "cancelled"
    with SessionLocal() as db:
        assert db.get(ReportRow, uuid.UUID(run_id)) is None


def test_timeout(svc, monkeypatch):
    def hang(path, llm, *, options=None, on_progress=None, document_name=None):
        time.sleep(4)
        return SAMPLE

    monkeypatch.setattr(req_core, "validate_document", hang)
    monkeypatch.setattr(get_settings(), "run_timeout_s", 1)
    run_id = make_run(svc)
    assert run_validation.delay(run_id).get() == "failed"
    assert "Превышено время прогона" in get_run(run_id).error


def test_skip_finished_and_missing(svc):
    run_id = make_run(svc)
    with SessionLocal() as db:
        run = db.get(Run, uuid.UUID(run_id))
        run.status = run.stage = "cancelled"
        db.commit()
    assert run_validation.delay(run_id).get() == "cancelled"
    assert run_validation.delay(str(uuid.uuid4())).get() == "missing"


def test_export_failure_is_not_fatal(svc, monkeypatch):
    monkeypatch.setattr(req_core, "validate_document", fake_validate)

    def render(report, fmt):
        if fmt == "pdf":
            raise RuntimeError("no fonts")
        return b"ok"

    monkeypatch.setattr(req_core, "render_report", render)
    run_id = make_run(svc)
    assert run_validation.delay(run_id).get() == "done"
    with SessionLocal() as db:
        assert set(db.get(ReportRow, uuid.UUID(run_id)).artifacts) == {"md", "docx"}


def test_describe_error():
    assert "429" in describe_error(Exception("429 RESOURCE_EXHAUSTED"), 10)
    assert describe_error(ValueError("x"), 10) == "ValueError: x"
