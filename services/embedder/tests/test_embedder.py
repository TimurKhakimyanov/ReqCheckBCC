import json
import math

import httpx
import numpy as np
import pytest
import sentence_transformers
import embedder.main as main_mod
from embedder import backends
from embedder.backends import ConfigError, GeminiBackend, HashBackend, LocalBackend, OpenAIBackend, remote_backend
from embedder.main import create_app
from fastapi.testclient import TestClient


@pytest.fixture
def client():
    with TestClient(create_app(HashBackend(32))) as c:
        yield c


def test_info_and_embed(client):
    assert client.get("/info").json() == {"provider": "hash", "model": "hash-32", "dim": 32, "normalized": True}
    r = client.post("/embed", json={"texts": ["порог расходов", "push уведомление"], "kind": "query"})
    body = r.json()
    assert r.status_code == 200 and body["dim"] == 32 and len(body["vectors"]) == 2
    assert all(math.isclose(sum(x * x for x in v), 1.0, rel_tol=1e-6) for v in body["vectors"])
    assert client.post("/embed", json={"texts": []}).status_code == 422
    assert client.post("/embed", json={"texts": ["a"], "kind": "other"}).status_code == 422
    assert "reqcheck_embedder_texts_total" in client.get("/metrics").text


def test_local_backend_built_at_startup(tmp_path, monkeypatch):
    monkeypatch.setattr(backends, "MODEL_FILE", tmp_path / "MODEL")
    assert backends.local_model_name() == "intfloat/multilingual-e5-small"  # файла нет — модель по умолчанию
    (tmp_path / "MODEL").write_text("intfloat/multilingual-e5-base")
    assert backends.local_model_name() == "intfloat/multilingual-e5-base"
    with TestClient(create_app(local_factory=lambda: HashBackend(8))) as c:
        assert c.get("/info").json()["dim"] == 8


def test_remote_provider_per_request(client, monkeypatch):
    seen = {}

    def fake_remote(provider, model, api_key, dim=None):
        seen.update(provider=provider, model=model, api_key=api_key, dim=dim)
        return HashBackend(dim or 16)

    monkeypatch.setattr(main_mod, "remote_backend", fake_remote)
    r = client.post("/embed", json={"texts": ["x"], "kind": "query", "provider": "gemini", "api_key": "k", "dim": 24})
    assert r.status_code == 200 and r.json()["dim"] == 24
    assert seen == {"provider": "gemini", "model": None, "api_key": "k", "dim": 24}
    # без провайдера — локальная модель
    assert client.post("/embed", json={"texts": ["x"]}).json()["dim"] == 32


def test_remote_without_key_is_400(client):
    r = client.post("/embed", json={"texts": ["x"], "provider": "openai"})
    assert r.status_code == 400 and "api_key" in r.json()["detail"]


class FakeST:
    def __init__(self, model, device):
        self.model, self.device, self.seen = model, device, []

    def get_sentence_embedding_dimension(self):
        return 4

    def encode(self, texts, **kw):
        assert kw["normalize_embeddings"] is True
        self.seen.extend(texts)
        return np.ones((len(texts), 4)) / 2


def test_local_backend_uses_e5_prefixes(monkeypatch):
    monkeypatch.setattr(sentence_transformers, "SentenceTransformer", FakeST)
    b = LocalBackend("intfloat/multilingual-e5-small")
    assert b.dim == 4 and b._st.device == "cpu"
    b.embed(["вопрос"], "query")
    b.embed(["абзац"], "passage")
    assert b._st.seen == ["query: вопрос", "passage: абзац"]


def test_gemini_backend():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["x-goog-api-key"] == "k"
        body = json.loads(request.content)
        assert body["requests"][0]["taskType"] == "RETRIEVAL_QUERY"
        return httpx.Response(200, json={"embeddings": [{"values": [3.0, 4.0]} for _ in body["requests"]]})

    b = GeminiBackend("gemini-embedding-001", "k", dim=2, client=httpx.Client(transport=httpx.MockTransport(handler)))
    assert b.embed(["a", "b"], "query") == [[0.6, 0.8], [0.6, 0.8]]


def test_openai_backend():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer k"
        n = len(json.loads(request.content)["input"])
        return httpx.Response(200, json={"data": [{"index": i, "embedding": [0.0, 2.0, 0.0]} for i in range(n)]})

    b = OpenAIBackend("text-embedding-3-small", "k", client=httpx.Client(transport=httpx.MockTransport(handler)))
    assert b.dim == 3 and b.embed(["x"], "passage") == [[0.0, 1.0, 0.0]]


def test_remote_backend_factory():
    with pytest.raises(ConfigError, match="api_key"):
        remote_backend("gemini", None, None)
    with pytest.raises(ConfigError, match="Unknown"):
        remote_backend("nope", None, "k")
    b = remote_backend("openai", None, "k")
    assert b.model == "text-embedding-3-small" and remote_backend("openai", None, "k") is b
    assert remote_backend("gemini", None, "k", 256).dim == 256
