"""Вертикальный срез API: вход → провайдеры → загрузка → прогон → SSE → отчёт → дефекты → чат → поиск."""

from __future__ import annotations

import asyncio
import os
import json
import uuid
from datetime import datetime, timezone

from app import testing
from app.db import SessionLocal
from app.indexing import index_report
from app.knowledge import ensure_builtin
from app.models import ReportRow, Run
from app.services import run_cancel_key, run_events_channel
from req_contracts import ProgressEvent, Report, RunStage

SAMPLE = testing.sample_report_dict()
DOC_TEXT = SAMPLE["document"]["text"].encode()
state: dict = {}


def parse_sse(body: str) -> list[tuple[str, str]]:
    events = []
    for block in body.split("\n\n"):
        name, data = None, []
        for line in block.splitlines():
            if line.startswith("event: "):
                name = line[7:]
            elif line.startswith("data: "):
                data.append(line[6:])
        if name:
            events.append((name, "\n".join(data)))
    return events


async def test_health_and_auth(anon):
    r = await anon.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body["checks"]["postgres"] == "ok" and body["checks"]["redis"] == "ok"
    assert body["checks"]["qdrant"] == "ok" and body["checks"]["embedder"] == "ok"

    r = await anon.get("/api/documents")
    assert r.status_code == 401 and r.json()["code"] == "unauthorized"

    r = await anon.post("/api/auth/login", json={"username": "admin", "password": "wrong"})
    assert r.status_code == 401 and r.json()["code"] == "invalid_credentials"


async def test_me_and_locale(client):
    r = await client.get("/api/auth/me")
    assert r.status_code == 200
    assert r.json()["role"] == "admin"
    r = await client.patch("/api/auth/me", json={"locale": "kk"})
    assert r.json()["locale"] == "kk"
    r = await client.patch("/api/auth/me", json={"password": {"current": "nope", "new": "something-long"}})
    assert r.status_code == 400 and r.json()["code"] == "invalid_password"


async def test_providers(client):
    r = await client.get("/api/providers")
    assert [p["provider"] for p in r.json()] == ["gemini", "openai", "anthropic", "openai_compatible"]
    secret = "AIza-test-key-1234567890"
    r = await client.put("/api/providers/gemini", json={"api_key": secret, "default_model": "gemini-2.5-flash"})
    assert r.status_code == 200
    p = r.json()
    assert p["has_key"] and p["key_hint"] == "…7890" and p["default_model"] == "gemini-2.5-flash"
    assert secret not in (await client.get("/api/providers")).text
    r = await client.get("/api/providers/gemini/models")
    assert r.json()["models"] == ["model-a", "model-b"]
    r = await client.put("/api/providers/nope", json={})
    assert r.status_code == 422


async def test_upload_document(client):
    r = await client.post("/api/documents", files={"file": ("requirements.md", DOC_TEXT, "text/markdown")})
    assert r.status_code == 201, r.text
    doc = r.json()
    assert doc["format"] == "md" and doc["size_bytes"] == len(DOC_TEXT) and doc["runs_count"] == 0
    state["doc"] = doc

    r = await client.post("/api/documents", files={"file": ("evil.exe", b"MZ", "application/octet-stream")})
    assert r.status_code == 415 and r.json()["code"] == "unsupported_format"

    r = await client.get(f"/api/documents/{doc['id']}/file")
    assert r.status_code == 200 and r.content == DOC_TEXT
    assert "attachment" in r.headers["content-disposition"]

    r = await client.get("/api/documents", params={"q": "requirements"})
    assert r.json()["total"] == 1


async def test_create_run_and_errors(client, services):
    doc = state["doc"]
    r = await client.post("/api/runs", json={"document_id": doc["id"], "provider": "openai", "model": "gpt-4.1"})
    assert r.status_code == 400 and r.json()["code"] == "provider_not_configured"
    r = await client.post("/api/runs", json={"document_id": str(uuid.uuid4()), "provider": "gemini", "model": "x"})
    assert r.status_code == 404

    r = await client.post("/api/runs", json={"document_id": doc["id"], "provider": "gemini",
                                             "model": "gemini-2.5-flash", "options": {"verify_pass": True}})
    assert r.status_code == 202, r.text
    run = r.json()
    assert run["status"] == "queued" and run["document_name"] == "requirements.md"
    assert run["options"]["verify_pass"] is True
    assert services.enqueued[-1] == run["id"]
    state["run"] = run

    r = await client.get(f"/api/runs/{run['id']}/report")
    assert r.status_code == 404 and r.json()["code"] == "report_not_ready"


def _finish_run_like_worker(services, run_id: str, doc_id: str) -> None:
    report = Report.model_validate(SAMPLE)
    with SessionLocal() as db:
        run = db.get(Run, uuid.UUID(run_id))
        db.add(ReportRow(run_id=run.id, data=report.model_dump(mode="json"), artifacts={}))
        run.status = run.stage = "done"
        run.progress = 1.0
        run.finished_at = datetime.now(timezone.utc)
        run.usage = {"llm_calls": 12, "prompt_tokens": 1000, "completion_tokens": 500, "cost_usd": 0.01,
                     "duration_s": 42.0}
        run.summary = report.summary.model_dump(mode="json")
        db.commit()
    index_report(services.vectors, run_id, doc_id, "requirements.md", report)


async def test_progress_sse(client, services):
    run_id, doc_id = state["run"]["id"], state["doc"]["id"]
    task = asyncio.create_task(client.get(f"/api/runs/{run_id}/events"))
    await asyncio.sleep(0.5)  # дождаться подписки
    services.redis.publish(run_events_channel(run_id), ProgressEvent(
        run_id=run_id, stage=RunStage.CHECKING_REQUIREMENTS, progress=0.5, message="3/6", current=3, total=6,
    ).model_dump_json())
    await asyncio.to_thread(_finish_run_like_worker, services, run_id, doc_id)
    services.redis.publish(run_events_channel(run_id), ProgressEvent(
        run_id=run_id, stage=RunStage.DONE, progress=1.0).model_dump_json())
    r = await asyncio.wait_for(task, timeout=10)
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/event-stream")
    events = parse_sse(r.text)
    stages = [json.loads(d)["stage"] for name, d in events if name == "progress"]
    assert stages == ["queued", "checking_requirements", "done"]

    # повторное подключение к завершённому прогону: одно событие с текущим состоянием
    r = await client.get(f"/api/runs/{run_id}/events")
    assert [json.loads(d)["stage"] for _, d in parse_sse(r.text)] == ["done"]


async def test_report_and_exports(client):
    run_id = state["run"]["id"]
    r = await client.get(f"/api/runs/{run_id}")
    run = r.json()
    assert run["status"] == "done" and run["summary"]["findings_total"] == SAMPLE["summary"]["findings_total"]
    assert run["usage"]["llm_calls"] == 12

    r = await client.get(f"/api/runs/{run_id}/report")
    assert r.status_code == 200 and r.json()["passport"] == SAMPLE["passport"]

    for fmt in ("md", "docx", "pdf", "json"):
        r = await client.get(f"/api/runs/{run_id}/report.{fmt}")
        assert r.status_code == 200, (fmt, r.text)
        assert "attachment" in r.headers["content-disposition"] and f".{fmt}" in r.headers["content-disposition"]
    assert (await client.get(f"/api/runs/{run_id}/report.exe")).status_code == 422

    r = await client.get("/api/documents/" + state["doc"]["id"])
    assert r.json()["runs_count"] == 1 and r.json()["last_run"]["status"] == "done"


async def test_findings_review(client):
    run_id = state["run"]["id"]
    r = await client.get(f"/api/runs/{run_id}/findings")
    items = r.json()
    assert len(items) == len(SAMPLE["findings"])
    assert all(i["review"]["status"] == "open" for i in items)
    fid = items[0]["finding"]["id"]
    r = await client.patch(f"/api/runs/{run_id}/findings/{fid}", json={"status": "false_positive", "comment": "ок"})
    assert r.status_code == 200 and r.json()["status"] == "false_positive"
    r = await client.get(f"/api/runs/{run_id}/findings")
    assert r.json()[0]["review"] == {**r.json()[0]["review"], "status": "false_positive", "comment": "ок"}
    r = await client.patch(f"/api/runs/{run_id}/findings/D-999", json={"status": "fixed"})
    assert r.status_code == 404


async def test_chat(client):
    run_id = state["run"]["id"]
    r = await client.post(f"/api/runs/{run_id}/chat", json={"message": "Что исправить первым?"})
    assert r.status_code == 200
    events = parse_sse(r.text)
    tokens = "".join(json.loads(d)["text"] for n, d in events if n == "token")
    assert "Что исправить первым?" in tokens
    assert events[-1][0] == "done"
    done = json.loads(events[-1][1])
    assert done["role"] == "assistant" and done["content"] == tokens.strip()

    history = (await client.get(f"/api/runs/{run_id}/chat")).json()
    assert [m["role"] for m in history] == ["user", "assistant"]
    assert (await client.delete(f"/api/runs/{run_id}/chat")).status_code == 204
    assert (await client.get(f"/api/runs/{run_id}/chat")).json() == []


async def test_search(client):
    finding = SAMPLE["findings"][0]
    r = await client.get("/api/search", params={"q": finding["title"], "kind": "finding", "limit": 3})
    assert r.status_code == 200
    hits = r.json()
    assert hits and hits[0]["finding_id"] == finding["id"] and hits[0]["run_id"] == state["run"]["id"]
    r = await client.get("/api/search", params={"q": "push", "kind": "requirement"})
    assert all(h["kind"] == "requirement" for h in r.json())


async def test_knowledge(client, services):
    assert await asyncio.to_thread(ensure_builtin, services)
    items = (await client.get("/api/knowledge")).json()
    builtin = [i for i in items if i["source"] == "builtin"]
    assert builtin and builtin[0]["status"] == "ready" and builtin[0]["chunks"] == 18

    r = await client.post("/api/knowledge", json={"title": "Глоссарий", "text": "Порог — сумма в тенге.\n\nПуш — уведомление."})
    assert r.status_code == 201, r.text
    manual_id = r.json()["id"]
    r = await client.post("/api/knowledge", files={"file": ("tpl.md", "# Шаблон\n\nРаздел 1".encode(), "text/markdown")})
    assert r.status_code == 201, r.text
    items = {i["id"]: i for i in (await client.get("/api/knowledge")).json()}
    assert items[manual_id]["status"] == "ready" and items[manual_id]["source"] == "manual"
    assert items[r.json()["id"]]["source"] == "upload"
    assert (await client.delete(f"/api/knowledge/{manual_id}")).status_code == 204
    assert (await client.post("/api/knowledge", json={"title": "x"})).status_code == 422


def test_reindex_into_empty_qdrant():
    """Пустой Qdrant (или смена модели эмбеддингов) → api при старте переиндексирует базу знаний и отчёты."""
    from app.knowledge import sync_vectors
    from app.vectors import KNOWLEDGE, REQUIREMENTS

    fresh = testing.RecordingServices(os.environ["REDIS_URL"])
    assert sync_vectors(fresh)
    hits = fresh.vectors.search(REQUIREMENTS, SAMPLE["findings"][0]["title"], limit=1, filters={"kind": "finding"})
    assert hits and hits[0].payload["run_id"] == state["run"]["id"]
    titles = {p.payload["title"] for p in fresh.vectors.search(KNOWLEDGE, "шаблон раздел", limit=50)}
    assert "tpl" in titles and any("Критерии" in t for t in titles)


async def test_cancel_and_delete(client, services):
    r = await client.post("/api/runs", json={"document_id": state["doc"]["id"]})
    assert r.status_code == 202, r.text
    run = r.json()
    assert run["provider"] == "gemini" and run["model"] == "gemini-2.5-flash"
    r = await client.post(f"/api/runs/{run['id']}/cancel")
    assert r.json()["status"] == "cancelled"
    assert services.redis.get(run_cancel_key(run["id"])) == "1"
    r = await client.get("/api/runs", params={"status": "cancelled"})
    assert [x["id"] for x in r.json()["items"]] == [run["id"]]
    assert (await client.delete(f"/api/runs/{run['id']}")).status_code == 204
    assert (await client.get(f"/api/runs/{run['id']}")).status_code == 404


async def test_usage_and_audit(client):
    r = await client.get("/api/usage")
    body = r.json()
    assert body["totals"]["runs"] == 1 and body["totals"]["prompt_tokens"] == 1000
    assert body["by_provider"][0]["provider"] == "gemini" and len(body["by_day"]) == 1
    r = await client.get("/api/audit", params={"limit": 100})
    actions = {i["action"] for i in r.json()["items"]}
    assert {"login", "login_failed", "provider_updated", "document_uploaded", "run_created", "run_cancelled",
            "finding_reviewed"} <= actions


async def test_delete_document(client, services):
    doc_id = state["doc"]["id"]
    assert (await client.delete(f"/api/documents/{doc_id}")).status_code == 204
    assert (await client.get(f"/api/documents/{doc_id}")).status_code == 404
    assert (await client.get(f"/api/runs/{state['run']['id']}")).status_code == 404
    assert not any(k.startswith(f"documents/{doc_id}") for k in services.store.objects)


async def test_openapi_and_metrics(anon):
    spec = (await anon.get("/api/openapi.json")).json()
    for path in ("/api/auth/login", "/api/runs/{run_id}/events", "/api/runs/{run_id}/report.{fmt}",
                 "/api/runs/{run_id}/chat", "/api/search", "/api/knowledge", "/api/usage", "/api/audit"):
        assert path in spec["paths"], path
    r = await anon.get("/metrics")
    assert r.status_code == 200 and "reqcheck_http_requests_total" in r.text


async def test_logout(anon):
    r = await anon.post("/api/auth/login", json={"username": "admin", "password": "test-password"})
    assert r.status_code == 200 and "httponly" in r.headers["set-cookie"].lower()
    assert (await anon.get("/api/auth/me")).status_code == 200
    assert (await anon.post("/api/auth/logout")).status_code == 204
    assert (await anon.get("/api/auth/me")).status_code == 401
