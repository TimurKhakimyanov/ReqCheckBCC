"""Цепочка режимов структурированного вывода, модели с рассуждениями и live list_models — на фейковых SDK."""

import json
from types import SimpleNamespace as NS

import pytest
from pydantic import SecretStr
from req_contracts import ProviderConfig, ProviderName

from req_core import llm as L
from req_core.cli import _provider_config, build_parser
from req_core.schemas import ConclusionResult

GOOD = {"rationale": "Есть противоречие D-001.", "top_fixes": ["D-001"]}


@pytest.fixture(autouse=True)
def _clear_caps():
    L._CAPS.clear()
    yield
    L._CAPS.clear()


class BadRequest(Exception):
    status_code = 400


def cfg(provider, model, **kw):
    kw.setdefault("api_key", SecretStr("k"))
    return ProviderConfig(provider=provider, model=model, **kw)


# ---------------------------------------------------------------- Anthropic


class _Ctx:
    def __init__(self, msg):
        self.msg = msg
        self.text_stream = iter([b.text for b in msg.content if b.type == "text"])

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def get_final_message(self):
        return self.msg


class FakeAnthropic:
    def __init__(self, script):
        self.script = list(script)
        self.calls = []
        self.messages = self

    def stream(self, **kw):
        self.calls.append(kw)
        r = self.script.pop(0)
        if isinstance(r, Exception):
            raise r
        return _Ctx(r)


def amsg(*blocks, stop="end_turn"):
    return NS(content=list(blocks), stop_reason=stop, usage=NS(input_tokens=10, output_tokens=5))


def text_block(t):
    return NS(type="text", text=t)


def tool_block(data):
    return NS(type="tool_use", name=L.TOOL_NAME, input=data)


def anthropic(model, script):
    c = L.AnthropicLLM(cfg(ProviderName.ANTHROPIC, model))
    c.client = FakeAnthropic(script)
    return c


def test_anthropic_native_output_config_without_forced_tool_and_temperature():
    c = anthropic("claude-opus-5-5", [amsg(NS(type="thinking", thinking=""), text_block(json.dumps(GOOD)))])
    assert c.complete_json("sys", "user", ConclusionResult).top_fixes == ["D-001"]
    kw = c.client.calls[0]
    fmt = kw["extra_body"]["output_config"]["format"]
    assert fmt["type"] == "json_schema"
    assert fmt["schema"]["additionalProperties"] is False
    assert "tool_choice" not in kw and "tools" not in kw
    assert "temperature" not in kw  # Opus 5.5 отклоняет temperature
    assert kw["max_tokens"] == 32_000


def test_anthropic_falls_back_native_tool_prompt_and_remembers():
    err_native = BadRequest("400 invalid_request_error: output_config: Extra inputs are not permitted")
    err_tool = BadRequest('400 tool_choice: type "tool" and "any" are not supported for this model.')
    c = anthropic("claude-sonnet-5-5", [err_native, err_tool, amsg(text_block("```json\n" + json.dumps(GOOD) + "\n```")),
                                       amsg(text_block(json.dumps(GOOD)))])
    assert c.complete_json("sys", "user", ConclusionResult).rationale.startswith("Есть")
    first, second, third = c.client.calls
    assert "extra_body" in first
    assert second["tool_choice"] == {"type": "auto"} and second["tools"][0]["name"] == L.TOOL_NAME
    assert "JSON Schema" in third["system"] and "tools" not in third
    # второй вызов сразу идёт в режиме prompt — отказ запомнен на модель
    c.complete_json("sys", "user", ConclusionResult)
    assert "JSON Schema" in c.client.calls[3]["system"] and "extra_body" not in c.client.calls[3]
    assert L._CAPS[("anthropic", "", "claude-sonnet-5-5")] == "prompt"


def test_anthropic_tool_mode_reads_tool_use_or_text():
    L._CAPS[("anthropic", "", "claude-opus-5-5")] = "tool"
    c = anthropic("claude-opus-5-5", [amsg(text_block("Вызываю."), tool_block(GOOD), stop="tool_use"),
                                     amsg(text_block(json.dumps(GOOD)))])
    assert c.complete_json("s", "u", ConclusionResult).top_fixes == ["D-001"]
    assert c.complete_json("s", "u", ConclusionResult).top_fixes == ["D-001"]  # модель ответила текстом


def test_anthropic_truncated_json_retried_with_larger_limit():
    c = anthropic("claude-opus-5-5", [amsg(text_block('{"rationale": "обре'), stop="max_tokens"),
                                     amsg(text_block(json.dumps(GOOD)))])
    assert c.complete_json("s", "u", ConclusionResult).top_fixes == ["D-001"]
    assert c.client.calls[1]["max_tokens"] == 64_000
    assert "не прошёл" not in c.client.calls[1]["messages"][0]["content"]


def test_anthropic_old_model_keeps_temperature_and_refusal_is_error():
    c = anthropic("claude-haiku-4-5", [amsg(text_block("ok")), amsg(stop="refusal")])
    assert c.complete("s", "u") == "ok"
    assert c.client.calls[0]["temperature"] == 0.0
    with pytest.raises(L.LLMError, match="refusal"):
        c.complete("s", "u")


def test_anthropic_list_models():
    c = L.AnthropicLLM(cfg(ProviderName.ANTHROPIC, "x"))
    c.client = NS(models=NS(list=lambda limit: [NS(id="claude-opus-5-5"), NS(id="claude-sonnet-5-5")]))
    assert c.list_models() == ["claude-opus-5-5", "claude-sonnet-5-5"]


# ---------------------------------------------------------------- OpenAI / openai_compatible (vLLM, рассуждения)


class FakeCompletions:
    def __init__(self, script):
        self.script = list(script)
        self.calls = []

    def create(self, **kw):
        self.calls.append(kw)
        r = self.script.pop(0)
        if isinstance(r, Exception):
            raise r
        return r


def ochoice(content=None, finish="stop", tool_args=None, reasoning=None):
    calls = [NS(function=NS(name=L.TOOL_NAME, arguments=tool_args))] if tool_args else None
    msg = NS(content=content, tool_calls=calls, reasoning=reasoning)
    return NS(choices=[NS(message=msg, finish_reason=finish)], usage=NS(prompt_tokens=7, completion_tokens=3))


def openai_like(provider, model, script, **kw):
    c = L.OpenAILLM(cfg(provider, model, **kw))
    fc = FakeCompletions(script)
    c.client = NS(chat=NS(completions=fc), models=NS(list=lambda: []))
    return c, fc


VLLM = "http://vllm.example.local:8000/v1"


def test_compatible_without_key_uses_placeholder_only_for_sdk():
    c = L.OpenAILLM(ProviderConfig(provider=ProviderName.OPENAI_COMPATIBLE, model="m", base_url=VLLM))
    assert c.client.api_key == L.NO_KEY_PLACEHOLDER
    with pytest.raises(L.LLMConfigError, match="base_url"):
        L.OpenAILLM(ProviderConfig(provider=ProviderName.OPENAI_COMPATIBLE, model="m"))


def test_reasoning_model_think_tags_and_reasoning_field_ignored():
    content = "<think>Рассуждаю про {скобки} долго…</think>\n" + json.dumps(GOOD)
    c, fc = openai_like(ProviderName.OPENAI_COMPATIBLE, "mimo-v2.6-flash",
                        [ochoice(content, reasoning="длинное рассуждение"), ochoice("<think>x</think>Привет")],
                        api_key=None, base_url=VLLM)
    assert c.complete_json("s", "u", ConclusionResult).top_fixes == ["D-001"]
    kw = fc.calls[0]
    assert kw["max_tokens"] == 32_768  # не задано в конфиге — с запасом
    assert kw["response_format"]["type"] == "json_schema"
    assert c.complete("s", "u") == "Привет"


def test_truncated_json_from_reasoning_model_is_retried_with_double_limit():
    c, fc = openai_like(ProviderName.OPENAI_COMPATIBLE, "mimo", [
        ochoice('{"rationale": "обрез', finish="length"), ochoice(None, finish="length"), ochoice(json.dumps(GOOD))],
        base_url=VLLM, max_output_tokens=400)
    assert c.complete_json("s", "u", ConclusionResult).top_fixes == ["D-001"]
    assert [k["max_tokens"] for k in fc.calls] == [400, 800, 1600]


def test_openai_response_format_rejected_falls_back_to_tool_call():
    err = BadRequest("400 Invalid parameter: 'response_format' of type 'json_schema' is not supported with this model")
    c, fc = openai_like(ProviderName.OPENAI, "gpt-x", [err, ochoice("", finish="tool_calls", tool_args=json.dumps(GOOD))])
    assert c.complete_json("s", "u", ConclusionResult).top_fixes == ["D-001"]
    assert fc.calls[1]["tool_choice"] == "auto" and "response_format" not in fc.calls[1]
    assert "max_completion_tokens" not in fc.calls[0]  # для OpenAI лимит по умолчанию не задаём


def test_openai_list_models_only_chat():
    c = L.OpenAILLM(cfg(ProviderName.OPENAI, "x"))
    ids = ["gpt-6.2-sol", "text-embedding-3-large", "gpt-image-1", "o4-mini", "whisper-1", "gpt-6-luna",
           "gpt-4o-realtime-preview", "dall-e-3", "tts-1"]
    c.client = NS(models=NS(list=lambda: [NS(id=i) for i in ids]))
    assert c.list_models() == ["gpt-6-luna", "gpt-6.2-sol", "o4-mini"]


# ---------------------------------------------------------------- Gemini


class FakeGeminiModels:
    def __init__(self, script):
        self.script = list(script)
        self.calls = []

    def generate_content(self, model, contents, config):
        self.calls.append(config)
        r = self.script.pop(0)
        if isinstance(r, Exception):
            raise r
        return r


def gresp(*parts, finish="STOP"):
    cand = NS(content=NS(parts=list(parts)), finish_reason=finish)
    return NS(candidates=[cand], text="".join(p.text for p in parts),
              usage_metadata=NS(prompt_token_count=5, candidates_token_count=2, thoughts_token_count=1))


def test_gemini_native_then_prompt_fallback_and_thoughts_ignored():
    c = L.GeminiLLM(cfg(ProviderName.GEMINI, "gemini-3.8-flash"))
    err = BadRequest("400 INVALID_ARGUMENT: response_json_schema is not supported for this model")
    gm = FakeGeminiModels([err, gresp(NS(text="думаю", thought=True), NS(text=json.dumps(GOOD), thought=None))])
    c.client = NS(models=gm)
    assert c.complete_json("s", "u", ConclusionResult).top_fixes == ["D-001"]
    assert gm.calls[0].response_json_schema is not None
    assert gm.calls[1].response_json_schema is None and "JSON Schema" in gm.calls[1].system_instruction
    assert c.usage.completion_tokens == 3


def test_gemini_list_models_only_generate_content():
    c = L.GeminiLLM(cfg(ProviderName.GEMINI, "x"))
    models = [NS(name="models/gemini-3.8-flash", supported_actions=["generateContent", "countTokens"]),
              NS(name="models/gemini-embedding-001", supported_actions=["embedContent"]),
              NS(name="models/imagen-4", supported_actions=["predict"])]
    c.client = NS(models=NS(list=lambda: models))
    assert c.list_models() == ["gemini-3.8-flash"]


# ---------------------------------------------------------------- рассуждения в потоке чата


def test_think_filter_across_chunks():
    f = L._ThinkFilter()
    out = "".join(f.feed_all(iter(["Отв", "ет: <th", "ink>скрыто</thi", "nk> видно", " <b>да</b>"])))
    assert out == "Ответ: видно <b>да</b>"


def test_strip_reasoning_unclosed():
    assert L.strip_reasoning("<think>не закончил") == ""
    assert L.strip_reasoning("  <think>a</think> ответ ") == "ответ"


# ---------------------------------------------------------------- конфиг: CLI → ProviderConfig, без .env


def test_cli_builds_config_from_flags_and_process_env(monkeypatch):
    p = build_parser()
    args = p.parse_args(["in.md", "out.md", "--provider", "openai_compatible", "--base-url", VLLM,
                         "--model", "mimo-v2.6-flash", "--min-interval", "2", "--max-attempts", "3",
                         "--max-output-tokens", "50000"])
    c = _provider_config(args)
    assert c.base_url == VLLM and c.api_key is None and c.model == "mimo-v2.6-flash"
    assert c.min_interval_s == 2 and c.max_attempts == 3 and c.max_output_tokens == 50000

    monkeypatch.setenv("GEMINI_API_KEY", "from-env")
    c = _provider_config(p.parse_args(["in.md", "out.md"]))
    assert c.provider == ProviderName.GEMINI and c.api_key.get_secret_value() == "from-env"
    c = _provider_config(p.parse_args(["in.md", "out.md", "--api-key", "flag"]))
    assert c.api_key.get_secret_value() == "flag"


def test_core_ignores_llm_environment(monkeypatch):
    monkeypatch.setenv("LLM_MIN_INTERVAL_S", "99")
    monkeypatch.setenv("LLM_MAX_ATTEMPTS", "1")
    monkeypatch.setenv("OPENAI_COMPATIBLE_BASE_URL", "http://env-should-not-be-used/v1")
    monkeypatch.setenv("GEMINI_API_KEY", "env-key")
    c = L.OpenAILLM(ProviderConfig(provider=ProviderName.OPENAI_COMPATIBLE, model="m", base_url=VLLM,
                                   min_interval_s=0.5, max_attempts=4))
    assert c.min_interval == 0.5 and c.max_attempts == 4
    assert str(c.client.base_url).startswith(VLLM)
    with pytest.raises(L.LLMConfigError):
        L.GeminiLLM(ProviderConfig(provider=ProviderName.GEMINI, model="m"))  # ключ из окружения не берётся


# ---------------------------------------------------------------- extra_body (vLLM chat_template_kwargs)

THINK_OFF = {"chat_template_kwargs": {"enable_thinking": False}}
THINK_ON = {"chat_template_kwargs": {"enable_thinking": True}}


class EchoCompletions:
    """Отвечает «{}» на любой запрос (все LLM-схемы допускают пустой объект) и запоминает запросы."""

    def __init__(self):
        self.calls = []

    def create(self, **kw):
        self.calls.append(kw)
        return ochoice("{}")


def test_extra_body_everywhere_and_set_review_override(sample_path):
    from req_core import parse_document
    from req_core.pipeline import run_pipeline
    from req_contracts import ValidationOptions

    c = L.OpenAILLM(ProviderConfig(provider=ProviderName.OPENAI_COMPATIBLE, model="mimo", base_url=VLLM,
                                   max_output_tokens=48_000, context_tokens=131_072, extra_body=THINK_OFF,
                                   extra_body_set_review=THINK_ON))
    echo = EchoCompletions()
    c.client = NS(chat=NS(completions=echo), models=NS(list=lambda: []))
    run_pipeline(parse_document(sample_path), c, options=ValidationOptions(concurrency=4, batch_size=3))

    def is_set(kw):
        return any("в команде ревью технического задания" in m["content"] for m in kw["messages"])  # 6 рецензентов

    set_calls = [k for k in echo.calls if is_set(k)]
    other = [k for k in echo.calls if not is_set(k)]
    assert len(set_calls) == 6 and other
    assert all(k["extra_body"] == THINK_ON for k in set_calls)
    assert all(k["extra_body"] == THINK_OFF for k in other)
    assert all(k["max_tokens"] == 48_000 for k in echo.calls)
    assert c.extra_body == THINK_OFF  # после проверки набора — вернулся исходный


def test_anthropic_extra_body_merged_with_output_config():
    c = L.AnthropicLLM(cfg(ProviderName.ANTHROPIC, "claude-opus-5-5", extra_body={"output_config": {"effort": "high"}}))
    c.client = FakeAnthropic([amsg(text_block(json.dumps(GOOD)))])
    c.complete_json("s", "u", ConclusionResult)
    oc = c.client.calls[0]["extra_body"]["output_config"]
    assert oc["effort"] == "high" and oc["format"]["type"] == "json_schema"


def test_cli_extra_body_and_max_tokens_flags():
    p = build_parser()
    args = p.parse_args(["in.md", "out.md", "--provider", "openai_compatible", "--base-url", VLLM, "--model", "m",
                         "--extra-body", json.dumps(THINK_OFF), "--extra-body-set-review", json.dumps(THINK_ON),
                         "--max-tokens", "48000", "--concurrency", "4"])
    c = _provider_config(args)
    assert c.extra_body == THINK_OFF and c.extra_body_set_review == THINK_ON and c.max_output_tokens == 48000
    assert args.concurrency == 4
    with pytest.raises(SystemExit):
        p.parse_args(["in.md", "out.md", "--extra-body", "[1, 2]"])
