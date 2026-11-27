"""Тонкий слой над официальными SDK провайдеров LLM (без LiteLLM).

Общее для всех провайдеров:
- `complete_json` — структурированный вывод по Pydantic-схеме (нативный режим провайдера + проверка Pydantic,
  повтор с текстом ошибки при битом JSON);
- повторы с экспоненциальной задержкой при 429/5xx/сетевых ошибках (учитывается `retry in Ns` из ответа);
- учёт вызовов и токенов в `Usage`; temperature из конфига (по умолчанию 0).
"""

from __future__ import annotations

import json
import logging
import os
import random
import re
import threading
import time
from collections.abc import Callable, Iterator
from typing import Any, TypeVar

from pydantic import BaseModel, ValidationError
from req_contracts import ProviderConfig, ProviderName, Usage

log = logging.getLogger("req_core.llm")

T = TypeVar("T", bound=BaseModel)

# Предпочтительные модели по убыванию; первая доступная по list_models() становится моделью по умолчанию.
# Проверено по документации провайдеров на 2026-11 (gemini-1.5/2.0 выключены, 2.5 — устаревшие).
PREFERRED_MODELS: dict[ProviderName, list[str]] = {
    ProviderName.GEMINI: [
        "gemini-4-hydrogen", "gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite",
        "gemini-3-flash-preview", "gemini-2.5-flash",
    ],
    ProviderName.OPENAI: ["gpt-6.2-sol", "gpt-6.1-terra", "gpt-6.2-astra", "gpt-6-luna", "gpt-5.5", "gpt-5"],
    ProviderName.ANTHROPIC: ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"],
    ProviderName.OPENAI_COMPATIBLE: [],
}

API_KEY_ENV: dict[ProviderName, tuple[str, ...]] = {
    ProviderName.GEMINI: ("GEMINI_API_KEY", "GOOGLE_API_KEY"),
    ProviderName.OPENAI: ("OPENAI_API_KEY",),
    ProviderName.ANTHROPIC: ("ANTHROPIC_API_KEY",),
    ProviderName.OPENAI_COMPATIBLE: ("OPENAI_COMPATIBLE_API_KEY",),
}


class LLMError(RuntimeError):
    pass


class LLMConfigError(LLMError):
    pass


# ---------------------------------------------------------------- вспомогательное


def resolve_api_key(cfg: ProviderConfig) -> str | None:
    if cfg.api_key is not None and cfg.api_key.get_secret_value():
        return cfg.api_key.get_secret_value()
    for name in API_KEY_ENV[cfg.provider]:
        if os.environ.get(name):
            return os.environ[name]
    return None


def inline_schema(schema: type[BaseModel]) -> dict[str, Any]:
    """JSON Schema модели без $ref/$defs и служебных полей (title/default) — для всех провайдеров."""
    raw = schema.model_json_schema()
    defs = raw.pop("$defs", {})

    def walk(node: Any) -> Any:
        if isinstance(node, dict):
            if "$ref" in node:
                name = node["$ref"].rsplit("/", 1)[-1]
                merged = {**defs[name], **{k: v for k, v in node.items() if k != "$ref"}}
                return walk(merged)
            out = {}
            for k, v in node.items():
                if k in ("title", "default", "examples"):
                    continue
                out[k] = walk(v)
            if out.get("type") == "object" and "properties" in out:
                out.setdefault("required", list(out["properties"].keys()))
            return out
        if isinstance(node, list):
            return [walk(v) for v in node]
        return node

    return walk(raw)


def extract_json(raw: str) -> str:
    """Достаёт JSON-объект из ответа модели (снимает ```json-ограждения и текст вокруг)."""
    s = raw.strip()
    m = re.search(r"```(?:json)?\s*(.*?)```", s, re.S)
    if m:
        s = m.group(1).strip()
    if not s.startswith(("{", "[")):
        a, b = s.find("{"), s.rfind("}")
        if a >= 0 and b > a:
            s = s[a : b + 1]
    return s


def _status_of(e: BaseException) -> int | None:
    for attr in ("status_code", "code", "status"):
        v = getattr(e, attr, None)
        if isinstance(v, int):
            return v
    resp = getattr(e, "response", None)
    v = getattr(resp, "status_code", None)
    return v if isinstance(v, int) else None


_RETRYABLE_NAMES = {
    "APIConnectionError", "APITimeoutError", "RateLimitError", "InternalServerError", "ServerError",
    "ServiceUnavailableError", "OverloadedError", "ReadTimeout", "ConnectTimeout", "ConnectError",
    "RemoteProtocolError", "ReadError", "TimeoutException",
}


def is_retryable(e: BaseException) -> bool:
    status = _status_of(e)
    if status in (408, 409, 425, 429, 500, 502, 503, 504, 529):
        return True
    if type(e).__name__ in _RETRYABLE_NAMES:
        return True
    s = str(e)
    return any(m in s for m in ("RESOURCE_EXHAUSTED", "UNAVAILABLE", "overloaded", "Too Many Requests"))


def retry_after_seconds(e: BaseException) -> float | None:
    """Пауза, которую просит провайдер: заголовок Retry-After или `retry in 37s` / `retryDelay: '37s'`."""
    resp = getattr(e, "response", None)
    headers = getattr(resp, "headers", None)
    if headers is not None:
        try:
            ra = headers.get("retry-after")
            if ra:
                return float(ra)
        except (TypeError, ValueError):
            pass
    m = re.search(r"retry(?:Delay)?['\"]?\s*(?:in|:)\s*['\"]?(\d+(?:\.\d+)?)\s*s", str(e), re.I)
    return float(m.group(1)) if m else None


# ---------------------------------------------------------------- базовый клиент


class BaseLLM:
    provider: str = "base"
    max_attempts = int(os.environ.get("LLM_MAX_ATTEMPTS", "6"))
    json_attempts = 3

    def __init__(self, cfg: ProviderConfig):
        self.cfg = cfg
        self.model = cfg.model
        self.usage = Usage()
        self._lock = threading.Lock()
        self._last_call = 0.0
        self.min_interval = float(os.environ.get("LLM_MIN_INTERVAL_S", "0") or 0)
        self.sleep: Callable[[float], None] = time.sleep

    # --- реализуют провайдеры
    def _call(self, system: str, messages: list[dict[str, str]], schema: tuple[str, dict] | None) -> str:
        raise NotImplementedError

    def _stream(self, system: str, messages: list[dict[str, str]]) -> Iterator[str]:
        yield self._call(system, messages, None)

    # --- общая логика
    def add_usage(self, prompt: int | None, completion: int | None) -> None:
        with self._lock:
            self.usage.llm_calls += 1
            self.usage.prompt_tokens += int(prompt or 0)
            self.usage.completion_tokens += int(completion or 0)

    def _throttle(self) -> None:
        if self.min_interval <= 0:
            return
        with self._lock:
            wait = self._last_call + self.min_interval - time.monotonic()
            self._last_call = max(time.monotonic(), self._last_call + self.min_interval)
        if wait > 0:
            self.sleep(wait)

    def _with_retry(self, fn: Callable[[], str]) -> str:
        delay = 2.0
        for attempt in range(1, self.max_attempts + 1):
            self._throttle()
            try:
                return fn()
            except Exception as e:  # noqa: BLE001 — классифицируем ниже
                if attempt >= self.max_attempts or not is_retryable(e):
                    raise
                wait = retry_after_seconds(e) or delay
                wait = min(wait, 90.0) + random.uniform(0, 1.0)
                log.warning("LLM %s: %s; повтор %d/%d через %.0f с", self.provider, type(e).__name__,
                            attempt, self.max_attempts, wait)
                self.sleep(wait)
                delay = min(delay * 2, 60.0)
        raise LLMError("unreachable")  # pragma: no cover

    @staticmethod
    def _msgs(messages: list[Any]) -> list[dict[str, str]]:
        out = []
        for m in messages:
            role = m["role"] if isinstance(m, dict) else m.role
            content = m["content"] if isinstance(m, dict) else m.content
            if role == "system":
                continue
            out.append({"role": "assistant" if role == "assistant" else "user", "content": content})
        return out

    def complete(self, system: str, user: str) -> str:
        return self._with_retry(lambda: self._call(system, [{"role": "user", "content": user}], None))

    def complete_json(self, system: str, user: str, schema: type[T]) -> T:
        sch = (schema.__name__, inline_schema(schema))
        prompt = user
        last: Exception | None = None
        for _ in range(self.json_attempts):
            raw = self._with_retry(lambda: self._call(system, [{"role": "user", "content": prompt}], sch))
            try:
                return schema.model_validate_json(extract_json(raw))
            except (ValidationError, ValueError) as e:
                last = e
                log.warning("LLM %s: ответ не прошёл схему %s: %s", self.provider, schema.__name__, str(e)[:300])
                prompt = (
                    user + "\n\nПредыдущий ответ не прошёл проверку JSON-схемы:\n" + str(e)[:1500]
                    + "\nВерни только корректный JSON-объект строго по схеме, без пояснений."
                )
        raise LLMError(f"Модель {self.model} не вернула корректный JSON по схеме {schema.__name__}: {last}")

    def stream(self, system: str, messages: list[Any]) -> Iterator[str]:
        msgs = self._msgs(messages)
        self._throttle()
        attempt = 0
        while True:
            attempt += 1
            started = False
            try:
                for chunk in self._stream(system, msgs):
                    started = True
                    if chunk:
                        yield chunk
                return
            except Exception as e:  # noqa: BLE001
                if started or attempt >= self.max_attempts or not is_retryable(e):
                    raise
                self.sleep(min(retry_after_seconds(e) or 2.0 * attempt, 60.0))

    def list_models(self) -> list[str]:
        return []


def schema_instruction(schema: dict) -> str:
    return (
        "\n\nОтвет — только JSON-объект по этой JSON Schema (без markdown и пояснений):\n"
        + json.dumps(schema, ensure_ascii=False)
    )


# ---------------------------------------------------------------- Gemini (google-genai)


class GeminiLLM(BaseLLM):
    provider = "gemini"

    def __init__(self, cfg: ProviderConfig):
        super().__init__(cfg)
        from google import genai
        from google.genai import types

        key = resolve_api_key(cfg)
        if not key:
            raise LLMConfigError("Не задан ключ Gemini: GEMINI_API_KEY (получить: https://aistudio.google.com/)")
        self._types = types
        self.client = genai.Client(api_key=key, http_options=types.HttpOptions(timeout=int(cfg.timeout_s * 1000)))
        self._native_schema = True

    def _contents(self, messages: list[dict[str, str]]):
        t = self._types
        return [
            t.Content(role="model" if m["role"] == "assistant" else "user", parts=[t.Part(text=m["content"])])
            for m in messages
        ]

    def _config(self, system: str, schema: tuple[str, dict] | None):
        t = self._types
        kw: dict[str, Any] = {"system_instruction": system, "temperature": self.cfg.temperature}
        if self.cfg.max_output_tokens:
            kw["max_output_tokens"] = self.cfg.max_output_tokens
        if schema:
            kw["response_mime_type"] = "application/json"
            if self._native_schema:
                kw["response_json_schema"] = schema[1]
            else:
                kw["system_instruction"] = system + schema_instruction(schema[1])
        try:
            return t.GenerateContentConfig(**kw)
        except Exception:  # старый SDK без response_json_schema
            kw.pop("response_json_schema", None)
            if schema:
                kw["system_instruction"] = system + schema_instruction(schema[1])
            return t.GenerateContentConfig(**kw)

    def _call(self, system, messages, schema):
        try:
            resp = self.client.models.generate_content(
                model=self.model, contents=self._contents(messages), config=self._config(system, schema)
            )
        except Exception as e:
            if schema and self._native_schema and _status_of(e) == 400 and "schema" in str(e).lower():
                self._native_schema = False  # схема не принята — передаём её в промпте
                return self._call(system, messages, schema)
            raise
        um = getattr(resp, "usage_metadata", None)
        self.add_usage(
            getattr(um, "prompt_token_count", 0),
            (getattr(um, "candidates_token_count", 0) or 0) + (getattr(um, "thoughts_token_count", 0) or 0),
        )
        text = resp.text
        if not text:
            reason = ""
            try:
                reason = str(resp.candidates[0].finish_reason)
            except Exception:  # noqa: BLE001
                pass
            raise LLMError(f"Gemini вернул пустой ответ {reason}".strip())
        return text

    def _stream(self, system, messages):
        last_um = None
        for chunk in self.client.models.generate_content_stream(
            model=self.model, contents=self._contents(messages), config=self._config(system, None)
        ):
            last_um = getattr(chunk, "usage_metadata", None) or last_um
            if chunk.text:
                yield chunk.text
        self.add_usage(getattr(last_um, "prompt_token_count", 0), getattr(last_um, "candidates_token_count", 0))

    def list_models(self) -> list[str]:
        out = []
        for m in self.client.models.list():
            name = (m.name or "").removeprefix("models/")
            actions = getattr(m, "supported_actions", None) or []
            if actions and "generateContent" not in actions:
                continue
            if "embedding" in name or "imagen" in name or "veo" in name:
                continue
            out.append(name)
        return sorted(set(out))


# ---------------------------------------------------------------- OpenAI и OpenAI-совместимые


class OpenAILLM(BaseLLM):
    provider = "openai"

    def __init__(self, cfg: ProviderConfig):
        super().__init__(cfg)
        from openai import OpenAI

        self.compatible = cfg.provider == ProviderName.OPENAI_COMPATIBLE
        self.provider = cfg.provider.value
        key = resolve_api_key(cfg)
        base_url = cfg.base_url or (os.environ.get("OPENAI_COMPATIBLE_BASE_URL") if self.compatible else None)
        if self.compatible and not base_url:
            raise LLMConfigError("Для openai_compatible нужен base_url (OPENAI_COMPATIBLE_BASE_URL)")
        if not key:
            if not self.compatible:
                raise LLMConfigError("Не задан ключ OpenAI: OPENAI_API_KEY")
            key = "not-needed"
        self.client = OpenAI(api_key=key, base_url=base_url, timeout=cfg.timeout_s, max_retries=0)
        self._use_temperature = True
        self._schema_mode = "json_schema"  # → json_object → prompt

    def _kwargs(self, system, messages, schema):
        sys_text = system
        kw: dict[str, Any] = {"model": self.model}
        if self._use_temperature:
            kw["temperature"] = self.cfg.temperature
        if self.cfg.max_output_tokens:
            kw["max_tokens" if self.compatible else "max_completion_tokens"] = self.cfg.max_output_tokens
        if schema:
            if self._schema_mode == "json_schema":
                kw["response_format"] = {
                    "type": "json_schema",
                    "json_schema": {"name": schema[0], "schema": schema[1], "strict": False},
                }
            else:
                sys_text = system + schema_instruction(schema[1])
                if self._schema_mode == "json_object":
                    kw["response_format"] = {"type": "json_object"}
        kw["messages"] = [{"role": "system", "content": sys_text}, *messages]
        return kw

    def _handle_bad_request(self, e: Exception, schema) -> bool:
        """True — параметр отключён, запрос стоит повторить."""
        msg = str(e).lower()
        if _status_of(e) not in (400, 422) and "badrequest" not in type(e).__name__.lower():
            return False
        if "temperature" in msg and self._use_temperature:
            self._use_temperature = False
            return True
        if schema and ("response_format" in msg or "json_schema" in msg or "schema" in msg):
            if self._schema_mode == "json_schema":
                self._schema_mode = "json_object"
                return True
            if self._schema_mode == "json_object":
                self._schema_mode = "prompt"
                return True
        return False

    def _call(self, system, messages, schema):
        for _ in range(4):
            try:
                resp = self.client.chat.completions.create(**self._kwargs(system, messages, schema))
                break
            except Exception as e:
                if self._handle_bad_request(e, schema):
                    continue
                raise
        else:  # pragma: no cover
            raise LLMError("OpenAI: запрос не принят ни в одном режиме")
        u = getattr(resp, "usage", None)
        self.add_usage(getattr(u, "prompt_tokens", 0), getattr(u, "completion_tokens", 0))
        text = resp.choices[0].message.content if resp.choices else None
        if not text:
            raise LLMError("OpenAI вернул пустой ответ")
        return text

    def _stream(self, system, messages):
        kw = self._kwargs(system, messages, None)
        try:
            stream = self.client.chat.completions.create(**kw, stream=True)
        except Exception as e:
            if self._handle_bad_request(e, None):
                stream = self.client.chat.completions.create(**self._kwargs(system, messages, None), stream=True)
            else:
                raise
        for ev in stream:
            if ev.choices and ev.choices[0].delta and ev.choices[0].delta.content:
                yield ev.choices[0].delta.content
        self.add_usage(0, 0)

    def list_models(self) -> list[str]:
        return sorted(m.id for m in self.client.models.list())


# ---------------------------------------------------------------- Anthropic


class AnthropicLLM(BaseLLM):
    provider = "anthropic"

    def __init__(self, cfg: ProviderConfig):
        super().__init__(cfg)
        import anthropic

        key = resolve_api_key(cfg)
        if not key:
            raise LLMConfigError("Не задан ключ Anthropic: ANTHROPIC_API_KEY")
        self.client = anthropic.Anthropic(api_key=key, timeout=cfg.timeout_s, max_retries=0)
        self._use_temperature = True

    def _kwargs(self, system, messages):
        kw: dict[str, Any] = {
            "model": self.model,
            "max_tokens": self.cfg.max_output_tokens or 16000,
            "system": system,
            "messages": messages,
        }
        if self._use_temperature:
            kw["temperature"] = self.cfg.temperature
        return kw

    def _call(self, system, messages, schema):
        kw = self._kwargs(system, messages)
        if schema:
            kw["tools"] = [{
                "name": "submit_result",
                "description": "Передать результат строго по схеме.",
                "input_schema": schema[1],
            }]
            kw["tool_choice"] = {"type": "tool", "name": "submit_result"}
        try:
            resp = self.client.messages.create(**kw)
        except Exception as e:
            if _status_of(e) == 400 and "temperature" in str(e).lower() and self._use_temperature:
                self._use_temperature = False
                return self._call(system, messages, schema)
            raise
        u = getattr(resp, "usage", None)
        self.add_usage(getattr(u, "input_tokens", 0), getattr(u, "output_tokens", 0))
        for block in resp.content:
            if getattr(block, "type", "") == "tool_use":
                return json.dumps(block.input, ensure_ascii=False)
        text = "".join(getattr(b, "text", "") for b in resp.content)
        if not text:
            raise LLMError("Anthropic вернул пустой ответ")
        return text

    def _stream(self, system, messages):
        with self.client.messages.stream(**self._kwargs(system, messages)) as s:
            yield from s.text_stream
            final = s.get_final_message()
        u = getattr(final, "usage", None)
        self.add_usage(getattr(u, "input_tokens", 0), getattr(u, "output_tokens", 0))

    def list_models(self) -> list[str]:
        return [m.id for m in self.client.models.list(limit=100)]


# ---------------------------------------------------------------- фабрика


_CLASSES: dict[ProviderName, type[BaseLLM]] = {
    ProviderName.GEMINI: GeminiLLM,
    ProviderName.OPENAI: OpenAILLM,
    ProviderName.OPENAI_COMPATIBLE: OpenAILLM,
    ProviderName.ANTHROPIC: AnthropicLLM,
}


def choose_model(provider: ProviderName, available: list[str]) -> str | None:
    prefs = PREFERRED_MODELS.get(provider, [])
    for p in prefs:
        if p in available:
            return p
    return prefs[0] if prefs else (available[0] if available else None)


def create_llm(cfg: ProviderConfig) -> BaseLLM:
    client = _CLASSES[cfg.provider](cfg)
    if not client.model:
        if cfg.provider == ProviderName.OPENAI_COMPATIBLE and os.environ.get("OPENAI_COMPATIBLE_MODEL"):
            client.model = os.environ["OPENAI_COMPATIBLE_MODEL"]
        else:
            try:
                available = client.list_models()
            except Exception as e:  # noqa: BLE001
                log.warning("Не удалось получить список моделей %s: %s", cfg.provider.value, e)
                available = []
            model = choose_model(cfg.provider, available)
            if not model:
                raise LLMConfigError(f"Не указана модель для {cfg.provider.value}")
            client.model = model
        client.cfg = cfg.model_copy(update={"model": client.model})
    return client


def list_provider_models(cfg: ProviderConfig) -> list[str]:
    client = _CLASSES[cfg.provider](cfg.model_copy(update={"model": cfg.model or "list"}))
    return client.list_models()
