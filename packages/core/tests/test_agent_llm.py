"""Слой вызова модели для агентов (req_core.agent.llm) — как в bbc-agent: окно модели от сервера и кэш ответов."""

from __future__ import annotations

import json
from types import SimpleNamespace

from req_contracts import ProviderConfig, ProviderName

from req_core.agent.llm import AgentLLM, detect_window
from req_core.llm import Reply


class Client:
    """Минимальный клиент: считает вызовы, отвечает JSON."""

    def __init__(self, window: int | None = None):
        self.cfg = ProviderConfig(provider=ProviderName.OPENAI_COMPATIBLE, model="m", base_url="http://llm/v1")
        self.model = "m"
        self.usage = SimpleNamespace(prompt_tokens=0, completion_tokens=0)
        self.calls = 0
        self.window = window

    def max_tokens(self) -> int:
        return 32_768

    def server_context_window(self) -> int | None:
        return self.window

    def complete_reply(self, system, user, limit, *, name=None):
        self.calls += 1
        self.usage.prompt_tokens += 100
        self.usage.completion_tokens += 10
        return Reply(json.dumps({"ok": True, "n": self.calls}))


def test_window_comes_from_the_server_like_bbc_agent():
    # vLLM отдаёт max_model_len — без этого окно считалось 32 000 и лимит ответа урезался до 16 000
    window, source = detect_window(Client(window=1_048_576))
    assert (window, source) == (1_048_576, "сообщил сервер")
    llm = AgentLLM(Client(window=1_048_576))
    assert llm.budget.output_reserve == 32_768
    # сервер не сообщил — прежняя оценка
    assert detect_window(Client(window=None))[0] == 32_000


def test_answers_are_cached_between_runs(tmp_path, monkeypatch):
    monkeypatch.setenv("LLM_CACHE_DIR", str(tmp_path))
    c1 = Client(window=1_000_000)
    first = AgentLLM(c1).json("inspector", "sys", "user", label="x")
    assert c1.calls == 1 and first == {"ok": True, "n": 1}
    # новый прогон, тот же запрос — ответ из кэша, модель не вызывается
    c2 = Client(window=1_000_000)
    seen: list[dict] = []
    llm = AgentLLM(c2, on_activity=seen.append)
    assert llm.json("inspector", "sys", "user", label="x") == first
    assert c2.calls == 0 and llm.cache_hits == 1 and seen[0]["cached"] is True
    # другой запрос (или модель, промпт, база знаний) — новый ключ
    assert llm.json("inspector", "sys", "other", label="x") == {"ok": True, "n": 1}
    assert c2.calls == 1


def test_cache_is_off_without_the_env(tmp_path, monkeypatch):
    monkeypatch.delenv("LLM_CACHE_DIR", raising=False)
    c = Client(window=1_000_000)
    llm = AgentLLM(c)
    llm.json("inspector", "sys", "user")
    llm.json("inspector", "sys", "user")
    assert c.calls == 2 and not list(tmp_path.iterdir())
