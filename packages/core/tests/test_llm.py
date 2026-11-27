import json

import pytest
from pydantic import BaseModel
from req_contracts import ProviderConfig, ProviderName

from req_core import get_llm
from req_core.llm import (
    BaseLLM,
    LLMConfigError,
    LLMError,
    choose_model,
    extract_json,
    inline_schema,
    is_retryable,
    retry_after_seconds,
)
from req_core.schemas import RequirementBatchResult, SegmentationResult


class Out(BaseModel):
    value: int = 0


class StatusError(Exception):
    def __init__(self, status, msg="err"):
        super().__init__(msg)
        self.status_code = status


class StubLLM(BaseLLM):
    provider = "stub"

    def __init__(self, replies):
        super().__init__(ProviderConfig(provider=ProviderName.OPENAI, model="stub"))
        self.replies = list(replies)
        self.prompts = []
        self.sleeps = []
        self.sleep = self.sleeps.append

    def _call(self, system, messages, schema):
        self.prompts.append(messages[-1]["content"])
        r = self.replies.pop(0)
        if isinstance(r, Exception):
            raise r
        self.add_usage(10, 5)
        return r


def test_inline_schema_has_no_refs():
    for schema in (SegmentationResult, RequirementBatchResult):
        s = inline_schema(schema)
        dumped = json.dumps(s)
        assert "$ref" not in dumped and "$defs" not in dumped
        assert s["type"] == "object"
    seg = inline_schema(SegmentationResult)
    item = seg["properties"]["requirements"]["items"]
    assert "functional" in item["properties"]["kind"]["enum"]


def test_extract_json():
    assert extract_json('```json\n{"a": 1}\n```') == '{"a": 1}'
    assert extract_json('Вот ответ: {"a": {"b": 2}} спасибо') == '{"a": {"b": 2}}'


def test_complete_json_retries_on_invalid_json():
    llm = StubLLM(["не json", '{"value": "abc"}', '{"value": 7}'])
    assert llm.complete_json("s", "u", Out).value == 7
    assert len(llm.prompts) == 3
    assert "не прошёл проверку" in llm.prompts[1]
    assert llm.usage.llm_calls == 3 and llm.usage.prompt_tokens == 30


def test_complete_json_gives_up():
    llm = StubLLM(["x", "y", "z"])
    with pytest.raises(LLMError):
        llm.complete_json("s", "u", Out)


def test_retry_on_429_and_5xx_with_backoff():
    llm = StubLLM([StatusError(429, "Please retry in 12.5s"), StatusError(503), '{"value": 1}'])
    assert llm.complete_json("s", "u", Out).value == 1
    assert all(s <= 5.0 for s in llm.sleeps)  # пауза нарезана на отрезки (для отмены)
    # 12.5 с по retry-after + 4 с экспоненциальной задержки (+ до 1 с джиттера на каждую)
    assert 12.5 + 4.0 <= sum(llm.sleeps) <= 13.5 + 5.0


def test_no_retry_on_400():
    llm = StubLLM([StatusError(400, "bad request")])
    with pytest.raises(StatusError):
        llm.complete("s", "u")
    assert llm.sleeps == []


def test_retry_helpers():
    assert is_retryable(StatusError(429))
    assert is_retryable(Exception("RESOURCE_EXHAUSTED: quota"))
    assert not is_retryable(StatusError(401))
    assert retry_after_seconds(Exception("{'retryDelay': '37s'}")) == 37.0
    assert retry_after_seconds(Exception("nothing")) is None


def test_choose_model():
    assert choose_model(ProviderName.GEMINI, ["gemini-2.5-flash", "gemini-3.8-flash"]) == "gemini-3.8-flash"
    assert choose_model(ProviderName.GEMINI, []) is not None
    assert choose_model(ProviderName.OPENAI_COMPATIBLE, ["qwen3:8b"]) == "qwen3:8b"


def test_missing_keys_are_reported():
    with pytest.raises(LLMConfigError):
        get_llm(ProviderConfig(provider=ProviderName.GEMINI, model="gemini-3.8-flash"))
    with pytest.raises(LLMConfigError):
        get_llm(ProviderConfig(provider=ProviderName.OPENAI, model="gpt-6.2-sol"))
    with pytest.raises(LLMConfigError):
        get_llm(ProviderConfig(provider=ProviderName.ANTHROPIC, model="claude-sonnet-5-5"))
    with pytest.raises(LLMConfigError):
        get_llm(ProviderConfig(provider=ProviderName.OPENAI_COMPATIBLE, model="m"))


def test_clients_construct_with_keys():
    from pydantic import SecretStr

    for p, m in ((ProviderName.GEMINI, "gemini-3.8-flash"), (ProviderName.OPENAI, "gpt-6.2-sol"),
                 (ProviderName.ANTHROPIC, "claude-sonnet-5-5")):
        c = get_llm(ProviderConfig(provider=p, model=m, api_key=SecretStr("test-key")))
        assert c.model == m
    c = get_llm(ProviderConfig(provider=ProviderName.OPENAI_COMPATIBLE, model="qwen3:8b",
                               base_url="http://ollama:11434/v1"))
    assert c.model == "qwen3:8b"
