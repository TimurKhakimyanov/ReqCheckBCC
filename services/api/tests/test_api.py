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
from app.models import ReportRow, Run, RunLog
from app.serialize import summary_from_report
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
    assert body["limits"] == {"max_upload_mb": 25}

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
    assert r.json()["models"] == ["gemini-2.5-flash", "gemini-2.5-pro"] and r.json()["default_model_valid"] is True
    r = await client.put("/api/providers/nope", json={})
    assert r.status_code == 422


async def test_settings(client, anon):
    r = await client.get("/api/settings")
    s = r.json()
    assert s["default_provider"] == "gemini" and s["run_timeout_s"] == 1800 and s["embeddings_provider"] == "local"
    assert s["embeddings_has_key"] is False and s["max_upload_mb"] == 25
    assert (await anon.get("/api/settings")).status_code == 401

    r = await client.put("/api/settings", json={"batch_size": 3, "concurrency": 2, "min_interval_s": 1.5,
                                                "max_attempts": 2, "max_upload_mb": 1,
                                                "embeddings_api_key": "emb-secret-123456"})
    assert r.status_code == 200, r.text
    s = r.json()
    assert (s["batch_size"], s["concurrency"], s["min_interval_s"], s["max_attempts"]) == (3, 2, 1.5, 2)
    assert s["embeddings_has_key"] and s["embeddings_key_hint"] == "…3456" and "emb-secret" not in r.text
    assert (await client.put("/api/settings", json={"batch_size": 0})).status_code == 422
    assert (await client.put("/api/settings", json={"embeddings_provider": "cohere"})).status_code == 422

    # лимит загрузки — из настроек
    assert (await anon.get("/api/health")).json()["limits"] == {"max_upload_mb": 1}
    r = await client.post("/api/documents", files={"file": ("big.txt", b"x" * (1024 * 1024 + 10), "text/plain")})
    assert r.status_code == 413
    await client.put("/api/settings", json={"max_upload_mb": 25, "embeddings_api_key": ""})
    assert (await client.get("/api/settings")).json()["embeddings_has_key"] is False


async def test_provider_test_uses_unsaved_values(client):
    calls = testing.CORE_CALLS
    r = await client.post("/api/providers/openai/test", json={"api_key": "sk-unsaved-1"})
    body = r.json()
    assert body["ok"] is True and body["models"] == ["model-a", "model-b"], body
    assert calls["complete"].api_key.get_secret_value() == "sk-unsaved-1"
    assert calls["complete"].max_attempts == 1  # проверка без повторов
    providers = {p["provider"]: p for p in (await client.get("/api/providers")).json()}
    assert providers["openai"]["has_key"] is False  # значения из формы не сохраняются

    r = await client.post("/api/providers/openai/test", json={"api_key": "bad-key"})
    assert r.json()["ok"] is False and "401" in r.json()["error"] and r.json()["models"] == []
    r = await client.post("/api/providers/openai/test")
    assert r.json()["ok"] is False and "API-ключ" in r.json()["error"]


async def test_openai_compatible_without_key(client):
    r = await client.post("/api/providers/openai_compatible/test")
    assert r.json()["ok"] is False and "base_url" in r.json()["error"]
    providers = {p["provider"]: p for p in (await client.get("/api/providers")).json()}
    assert providers["openai_compatible"]["base_url"] is None  # без адреса по умолчанию

    url = "http://vllm.example.local:8000/v1"
    r = await client.post("/api/providers/openai_compatible/test", json={"base_url": url})
    body = r.json()
    assert body["ok"] is True and body["models"] == ["model-a", "model-b"]
    cfg = testing.CORE_CALLS["complete"]
    assert cfg.base_url == url and cfg.api_key is None and cfg.model == "model-a"

    await client.put("/api/providers/openai_compatible", json={"base_url": url})
    # доп. поля запроса: объект, строка с JSON-объектом; не-объект — 422
    no_think, think = {"chat_template_kwargs": {"enable_thinking": False}}, {"chat_template_kwargs": {"enable_thinking": True}}
    r = await client.put("/api/providers/openai_compatible", json={
        "extra_body": no_think, "extra_body_set_review": '{"chat_template_kwargs": {"enable_thinking": true}}',
        "max_output_tokens": 48000})
    p = r.json()
    assert r.status_code == 200 and p["extra_body"] == no_think and p["extra_body_set_review"] == think, p
    assert p["max_output_tokens"] == 48000
    for bad in ("{not json", [1, 2], "[1]", 5):
        r = await client.put("/api/providers/openai_compatible", json={"extra_body": bad})
        assert r.status_code == 422, bad
    assert (await client.put("/api/providers/openai_compatible", json={"max_output_tokens": 0})).status_code == 422
    r = await client.post("/api/providers/openai_compatible/test")
    cfg = testing.CORE_CALLS["complete"]
    assert r.json()["ok"] and cfg.extra_body == no_think and cfg.extra_body_set_review == think
    assert cfg.max_output_tokens == 48000
    # таймаут одного запроса — по провайдеру, в т. ч. для проверки ключа
    r = await client.put("/api/providers/openai_compatible", json={"timeout_s": 900})
    assert r.json()["timeout_s"] == 900
    assert (await client.put("/api/providers/openai_compatible", json={"timeout_s": 5})).status_code == 422
    await client.post("/api/providers/openai_compatible/test")
    assert testing.CORE_CALLS["complete"].timeout_s == 900
    await client.post("/api/providers/openai_compatible/test", json={"extra_body": None})
    assert testing.CORE_CALLS["complete"].extra_body is None  # несохранённое значение из формы
    r = await client.get("/api/providers/openai_compatible/models")
    assert r.json()["models"] == ["model-a", "model-b"] and r.json()["error"] is None
    assert testing.CORE_CALLS["list_models"].base_url == url
    doc = (await client.post("/api/documents", files={"file": ("tmp.md", b"# x", "text/markdown")})).json()
    r = await client.post("/api/runs", json={"document_id": doc["id"], "provider": "openai_compatible",
                                             "model": "model-a", "options": {"batch_size": 10}})
    assert r.status_code == 202, r.text
    assert r.json()["options"]["batch_size"] == 10 and r.json()["options"]["concurrency"] == 2
    assert (await client.delete(f"/api/documents/{doc['id']}")).status_code == 204


async def test_stale_default_model(client):
    """Устаревшая модель по умолчанию: проверка идёт на живой модели, а админке приходит предупреждение."""
    from app.providers import reset_stale_default_models

    await client.put("/api/providers/anthropic", json={"api_key": "sk-ant-test-123456", "default_model": "claude-opus-4-1"})
    r = (await client.post("/api/providers/anthropic/test")).json()
    assert r["ok"] is True and r["model"] == "claude-sonnet-4-5", r
    assert r["default_model_valid"] is False and "claude-opus-4-1" in r["warning"]
    assert testing.CORE_CALLS["complete"].model == "claude-sonnet-4-5"
    m = (await client.get("/api/providers/anthropic/models")).json()
    assert m["default_model"] == "claude-opus-4-1" and m["default_model_valid"] is False and m["warning"]

    # список не получен (неверный ключ) — модель по умолчанию не трогаем
    await client.put("/api/providers/openai", json={"api_key": "bad-key", "default_model": "gpt-x"})
    reset = await asyncio.to_thread(reset_stale_default_models, testing.fake_list_models)
    assert reset == [("anthropic", "claude-opus-4-1")]
    providers = {p["provider"]: p for p in (await client.get("/api/providers")).json()}
    assert providers["anthropic"]["default_model"] is None and providers["openai"]["default_model"] == "gpt-x"
    assert providers["gemini"]["default_model"] == "gemini-2.5-flash"  # есть в списке — осталась
    m = (await client.get("/api/providers/anthropic/models")).json()
    assert m["default_model_valid"] is None and m["warning"] is None
    r = (await client.post("/api/providers/anthropic/test")).json()
    assert r["ok"] and r["model"] == "claude-sonnet-4-5" and r["default_model_valid"] is None
    await client.put("/api/providers/openai", json={"api_key": "", "default_model": ""})
    await client.put("/api/providers/anthropic", json={"api_key": ""})


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
    assert run["options"]["batch_size"] == 3 and run["options"]["concurrency"] == 2  # из /settings
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
        run.summary = summary_from_report(report)
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
    assert run["summary"]["ready_for_development"] == SAMPLE["conclusion"]["ready_for_development"]
    assert set(run["summary"]["by_severity"]) == {"critical", "major", "minor"}

    r = await client.get(f"/api/runs/{run_id}/report")
    assert r.status_code == 200 and r.json()["passport"] == SAMPLE["passport"]

    for fmt in ("md", "docx", "pdf", "json"):
        r = await client.get(f"/api/runs/{run_id}/report.{fmt}")
        assert r.status_code == 200, (fmt, r.text)
        assert "attachment" in r.headers["content-disposition"] and f".{fmt}" in r.headers["content-disposition"]
    assert (await client.get(f"/api/runs/{run_id}/report.exe")).status_code == 422

    r = await client.get("/api/documents/" + state["doc"]["id"])
    assert r.json()["runs_count"] == 1 and r.json()["last_run"]["status"] == "done"
    assert "ready_for_development" in r.json()["last_run"]["summary"]


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
    r = await client.delete(f"/api/knowledge/{builtin[0]['id']}")
    assert r.status_code == 409 and r.json()["code"] == "builtin_protected"
    assert (await client.post("/api/knowledge", json={"title": "x"})).status_code == 422


async def test_embeddings_change_reindexes(client, services):
    """Смена модели эмбеддингов в настройках → коллекции пересоздаются, всё индексируется заново."""
    from app.vectors import REQUIREMENTS

    r = await client.put("/api/settings", json={"embeddings_model": "intfloat/multilingual-e5-base"})
    assert r.json()["embeddings_model"] == "intfloat/multilingual-e5-base"
    assert REQUIREMENTS in services.qdrant.get_collections().model_dump_json()
    hits = (await client.get("/api/search", params={"q": SAMPLE["findings"][0]["title"], "kind": "finding"})).json()
    assert hits and hits[0]["finding_id"] == SAMPLE["findings"][0]["id"]
    items = (await client.get("/api/knowledge")).json()
    assert items and all(i["status"] == "ready" for i in items)
    r = await client.put("/api/settings", json={"embeddings_model": None})
    assert r.json()["embeddings_model"] is None
    actions = [a["action"] for a in (await client.get("/api/audit")).json()["items"]]
    assert "settings_updated" in actions

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


async def test_audit_filters_and_run_logs(client):
    r = await client.get("/api/audit", params={"action": "run_created"})
    body = r.json()
    assert body["items"] and all(i["action"] == "run_created" for i in body["items"])
    assert "login" in body["actions"] and "run_created" in body["actions"]
    r = await client.get("/api/audit", params={"q": state["doc"]["id"]})
    assert {i["action"] for i in r.json()["items"]} >= {"document_uploaded"}

    run_id = state["run"]["id"]
    with SessionLocal() as db:
        rid = uuid.UUID(run_id)
        db.add_all([
            RunLog(run_id=rid, level="info", source="progress", stage="parsing", message="Загрузка документа"),
            RunLog(run_id=rid, level="info", source="llm", stage="checking_requirements",
                   message="LLM gemini/x: ответ за 900 мс", data={"kind": "llm_call", "latency_ms": 900}),
            RunLog(run_id=rid, level="warning", source="core", stage="bogus", message="странная стадия"),
        ])
        db.commit()
    r = await client.get(f"/api/runs/{run_id}/logs")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["run"]["id"] == run_id and body["truncated"] is False
    assert [i["source"] for i in body["items"]] == ["progress", "llm", "core"]
    assert body["items"][1]["data"]["latency_ms"] == 900
    assert body["items"][2]["stage"] is None  # неизвестная стадия не ломает ответ
    assert {"run_created", "finding_reviewed"} <= {a["action"] for a in body["audit"]}
    assert (await client.get(f"/api/runs/{run_id}/logs", params={"limit": 1})).json()["truncated"] is True
    assert (await client.get(f"/api/runs/{uuid.uuid4()}/logs")).status_code == 404


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
    assert r.status_code == 200
    for name in ("reqcheck_http_requests_total", "reqcheck_http_request_duration_seconds", "reqcheck_sse_connections",
                 "reqcheck_llm_requests_total"):
        assert name in r.text, name
    assert 'route="/api/health"' not in r.text
    assert 'reqcheck_http_request_duration_seconds_count{method="GET",route="/api/runs/{run_id}/events"}' not in r.text


async def test_logout(anon):
    r = await anon.post("/api/auth/login", json={"username": "admin", "password": "test-password"})
    assert r.status_code == 200 and "httponly" in r.headers["set-cookie"].lower()
    assert (await anon.get("/api/auth/me")).status_code == 200
    assert (await anon.post("/api/auth/logout")).status_code == 204
    assert (await anon.get("/api/auth/me")).status_code == 401


def test_external_network_is_blocked():
    import socket

    import pytest

    with pytest.raises(RuntimeError, match="external network"):
        socket.create_connection(("8.8.8.8", 443), timeout=1)
