import json
import math

import httpx
import numpy as np
import pytest
import sentence_transformers
from embedder.backends import GeminiBackend, HashBackend, LocalBackend, OpenAIBackend, build_backend
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


def test_default_backend_from_env():
    with TestClient(create_app()) as c:  # EMBEDDINGS_PROVIDER=hash в тестовом образе
        assert c.get("/info").json()["provider"] == "hash"


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


def test_build_backend_errors():
    with pytest.raises(RuntimeError, match="GEMINI_API_KEY"):
        build_backend({"EMBEDDINGS_PROVIDER": "gemini"})
    with pytest.raises(RuntimeError, match="Unknown"):
        build_backend({"EMBEDDINGS_PROVIDER": "nope"})
    b = build_backend({"EMBEDDINGS_PROVIDER": "openai", "OPENAI_API_KEY": "k",
                       "EMBEDDINGS_MODEL": "intfloat/multilingual-e5-small"})
    assert b.model == "text-embedding-3-small"
