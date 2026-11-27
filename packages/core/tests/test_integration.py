"""Сценарии, в которых ядро вызывают API и воркер (см. docs/contract-changes/backend.md ветки бэкенда)."""

import io
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from req_contracts import ProviderConfig, ProviderName, Report, RunStage, ValidationOptions

import req_core
from req_core import ChatMessage, answer_question, get_llm, list_models, render_report, validate_document
from req_core.llm import BaseLLM
from req_core.pipeline import run_pipeline
from req_core.testing import FakeLLM


class RunCancelled(Exception):
    pass


# ---------------------------------------------------------------- отмена и прогресс воркера


def _cancel_after(stage: RunStage, n: int, events: list):
    def cb(ev):
        events.append(ev)
        if sum(e.stage == stage for e in events) >= n:
            raise RunCancelled("run cancelled")
    return cb


def test_validate_document_reports_every_requirement(sample_path, monkeypatch):
    llm = FakeLLM()
    monkeypatch.setattr(req_core, "get_llm", lambda cfg: llm)
    events = []
    report = validate_document(sample_path, ProviderConfig(provider=ProviderName.GEMINI, model="m"),
                               on_progress=events.append, document_name="ТЗ.md")
    assert report.passport.document_name == "ТЗ.md"
    top = [r for r in report.requirements if not r.parent_id]
    done = sorted({e.current for e in events if e.stage == RunStage.CHECKING_REQUIREMENTS and e.current})
    assert done == list(range(1, len(top) + 1))
    assert all(e.total == len(top) for e in events if e.stage == RunStage.CHECKING_REQUIREMENTS)
    assert events[0].stage == RunStage.PARSING and events[-1].stage == RunStage.DONE
    for fmt in ("md", "docx", "pdf"):
        assert render_report(report, fmt)


def test_exception_from_on_progress_aborts_pipeline(sample_path, monkeypatch):
    llm = FakeLLM()
    monkeypatch.setattr(req_core, "get_llm", lambda cfg: llm)
    events = []
    with pytest.raises(RunCancelled):
        validate_document(sample_path, ProviderConfig(provider=ProviderName.GEMINI, model="m"),
                          on_progress=_cancel_after(RunStage.CHECKING_REQUIREMENTS, 2, events))
    schemas = [c["schema"] for c in llm.calls if c["kind"] == "json"]
    assert "RoleReviewResult" not in schemas  # после отмены модель больше не вызывается
    assert events[-1].stage == RunStage.CHECKING_REQUIREMENTS


def test_cancel_with_parallel_batches(sample_path):
    with pytest.raises(RunCancelled):
        run_pipeline(req_core.parse_document(sample_path), FakeLLM(),
                     options=ValidationOptions(concurrency=3, batch_size=2),
                     on_progress=_cancel_after(RunStage.CHECKING_REQUIREMENTS, 1, []))


class RateLimited(Exception):
    status_code = 429


class AlwaysRateLimited(BaseLLM):
    provider = "stub"

    def __init__(self):
        super().__init__(ProviderConfig(provider=ProviderName.OPENAI, model="stub"))
        self.attempts = 0
        self.sleep = lambda s: None

    def _call(self, system, messages, schema, mode="prompt", max_tokens=None):
        self.attempts += 1
        raise RateLimited("Please retry in 30s")


def test_cancel_during_rate_limit_wait(sample_path):
    llm = AlwaysRateLimited()
    events = []

    def cb(ev):
        events.append(ev)
        if "повтор через" in ev.message:
            raise RunCancelled("run cancelled")

    with pytest.raises(RunCancelled):
        run_pipeline(req_core.parse_document(sample_path), llm, on_progress=cb)
    assert llm.attempts == 1  # отмена сработала во время паузы, до второй попытки
    assert "Лимит запросов провайдера" in events[-1].message


def test_rate_limit_heartbeats_without_cancel():
    llm = AlwaysRateLimited()
    llm.max_attempts = 2
    beats = []
    llm.on_wait = beats.append
    with pytest.raises(RateLimited):
        llm.complete("s", "u")
    assert len(beats) >= 6  # пауза ~30 с нарезана на отрезки по 5 с


# ---------------------------------------------------------------- openai_compatible через настоящий OpenAI SDK


class FakeOpenAIServer:
    """Минимальный OpenAI-совместимый сервер (как Ollama) на 127.0.0.1 — без внешней сети."""

    def __init__(self):
        self.requests: list[dict] = []
        self.reject_temperature = False
        self.reply = "pong"
        self.finish = "stop"
        server = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, code, body, ctype="application/json"):
                data = body.encode("utf-8") if isinstance(body, str) else body
                self.send_response(code)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                server.requests.append({"path": self.path, "auth": self.headers.get("Authorization")})
                if self.path.endswith("/models"):
                    self._send(200, json.dumps({"object": "list", "data": [
                        {"id": "qwen3:8b", "object": "model", "created": 0, "owned_by": "ollama"},
                        {"id": "llama3.1:8b", "object": "model", "created": 0, "owned_by": "ollama"}]}))
                else:
                    self._send(404, "{}")

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                server.requests.append({"path": self.path, "auth": self.headers.get("Authorization"), "body": body})
                if server.reject_temperature and "temperature" in body:
                    self._send(400, json.dumps({"error": {"message": "Unsupported parameter: 'temperature'",
                                                          "type": "invalid_request_error"}}))
                    return
                content = server.reply
                if body.get("response_format"):
                    content = json.dumps({"rationale": "ok", "top_fixes": ["D-001"]})
                if body.get("stream"):
                    chunks = [content[:2], content[2:]]
                    sse = "".join(
                        "data: " + json.dumps({"id": "c", "object": "chat.completion.chunk", "created": 0,
                                               "model": body["model"], "choices": [
                                                   {"index": 0, "delta": {"content": c}, "finish_reason": None}]})
                        + "\n\n" for c in chunks) + "data: [DONE]\n\n"
                    self._send(200, sse, "text/event-stream")
                    return
                self._send(200, json.dumps({
                    "id": "c", "object": "chat.completion", "created": 0, "model": body["model"],
                    "choices": [{"index": 0, "finish_reason": server.finish,
                                 "message": {"role": "assistant", "content": content}}],
                    "usage": {"prompt_tokens": 11, "completion_tokens": 3, "total_tokens": 14}}))

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.base_url = f"http://127.0.0.1:{self.httpd.server_address[1]}/v1"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self):
        self.httpd.shutdown()


@pytest.fixture
def oai_server():
    srv = FakeOpenAIServer()
    yield srv
    srv.close()


def _compat(srv, model="qwen3:8b", **kw):
    return ProviderConfig(provider=ProviderName.OPENAI_COMPATIBLE, model=model, base_url=srv.base_url, **kw)


def test_compatible_list_models_uses_base_url_from_config(oai_server):
    assert list_models(_compat(oai_server, model="-")) == ["llama3.1:8b", "qwen3:8b"]
    req = oai_server.requests[-1]
    assert req["path"] == "/v1/models"
    assert req["auth"] == "Bearer ollama"  # пустой ключ → «ollama»


def test_compatible_complete_like_provider_test_button(oai_server):
    cfg = _compat(oai_server).model_copy(update={"timeout_s": 30.0, "max_output_tokens": 16})
    assert get_llm(cfg).complete("Answer with one word.", "ping") == "pong"
    body = oai_server.requests[-1]["body"]
    assert body["model"] == "qwen3:8b" and body["max_tokens"] == 16 and body["temperature"] == 0.0
    # пустой ответ из-за лимита токенов — не ошибка проверки ключа
    oai_server.reply, oai_server.finish = "", "length"
    assert get_llm(cfg).complete("Answer with one word.", "ping") == ""


def test_compatible_temperature_rejected_is_retried_without_it(oai_server):
    oai_server.reject_temperature = True
    assert get_llm(_compat(oai_server)).complete("s", "ping") == "pong"
    assert "temperature" not in oai_server.requests[-1]["body"]


def test_compatible_model_autoselect_and_json(oai_server):
    from req_core.schemas import ConclusionResult

    client = get_llm(_compat(oai_server, model=""))
    assert client.model in {"qwen3:8b", "llama3.1:8b"}
    res = client.complete_json("s", "u", ConclusionResult)
    assert res.top_fixes == ["D-001"]
    assert oai_server.requests[-1]["body"]["response_format"]["type"] == "json_schema"
    assert client.usage.prompt_tokens == 11


def test_answer_question_streams_with_chat_history(oai_server, sample_report):
    history = [ChatMessage(role="user", content="Что с R-002?"),
               ChatMessage(role="assistant", content="Есть противоречие D-001.")]
    tokens = list(answer_question(sample_report, history, "Как исправить?", _compat(oai_server), ["Глоссарий"]))
    assert "".join(tokens) == "pong" and len(tokens) == 2
    body = oai_server.requests[-1]["body"]
    assert body["stream"] is True
    roles = [m["role"] for m in body["messages"]]
    assert roles == ["system", "user", "assistant", "user"]
    assert "D-001" in body["messages"][0]["content"]
    assert body["messages"][-1]["content"] == "Как исправить?"


def test_parse_document_with_upload_name(tmp_path):
    p = tmp_path / "upload.bin"
    p.write_bytes("# База знаний\n\nТиын — 1/100 тенге.\n".encode("utf-8"))
    doc = req_core.parse_document(p, name="glossary.md")
    assert doc.name == "glossary.md" and "Тиын" in doc.text


def test_report_json_roundtrip_after_pipeline(sample_path):
    report = run_pipeline(req_core.parse_document(sample_path), FakeLLM())
    again = Report.model_validate_json(render_report(report, "json"))
    assert again.summary == report.summary
    assert io.BytesIO(render_report(report, "docx")).getvalue()[:2] == b"PK"
