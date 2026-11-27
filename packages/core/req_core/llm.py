"""Тонкий слой над официальными SDK провайдеров LLM (без LiteLLM).

Все параметры берутся только из `ProviderConfig` — ядро не читает переменные окружения
(в CLI их собирает `req_core.cli`, в вебе — админка).

Структурированный вывод (`complete_json`) — цепочка отката, общая для провайдеров:
    1. `native`  — нативная JSON Schema провайдера (Gemini `response_json_schema`, OpenAI `response_format`,
                   Anthropic `output_config.format`);
    2. `tool`    — инструмент со схемой и `tool_choice: auto` + указание вызвать его (новые модели Claude
                   не принимают принудительный tool_choice);
    3. `prompt`  — схема в промпте + проверка Pydantic + повтор с текстом ошибки валидации.
Отказ модели по возможностям (400 о response_format / output_config / tool_choice / tools) запоминается
на пару (провайдер, base_url, модель) и следующие вызовы сразу идут нужным способом.

Модели с рассуждениями: поля `reasoning`/`thinking` игнорируются, `<think>…</think>` вырезается из текста;
ответ, обрезанный по лимиту токенов, повторяется с удвоенным лимитом.
"""

from __future__ import annotations

import json
import logging
import random
import re
import threading
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from typing import Any, TypeVar

from pydantic import BaseModel, ValidationError
from req_contracts import ProviderConfig, ProviderName, Usage

log = logging.getLogger("req_core.llm")

T = TypeVar("T", bound=BaseModel)

# Предпочтительные модели по убыванию: если модель не указана, берётся первая доступная ключу из list_models().
PREFERRED_MODELS: dict[ProviderName, list[str]] = {
    ProviderName.GEMINI: [
        "gemini-4-hydrogen", "gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite",
        "gemini-3-flash-preview", "gemini-2.5-flash",
    ],
    ProviderName.OPENAI: ["gpt-6.2-sol", "gpt-6.1-terra", "gpt-6.2-astra", "gpt-6-luna", "gpt-5.5", "gpt-5"],
    ProviderName.ANTHROPIC: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
    ProviderName.OPENAI_COMPATIBLE: [],
}

# Лимит ответа, если в конфиге не задан: модели с рассуждениями тратят токены на reasoning.
DEFAULT_MAX_TOKENS = {ProviderName.ANTHROPIC: 32_000, ProviderName.OPENAI_COMPATIBLE: 32_768}
MAX_TOKENS_CEILING = 131_072
NO_KEY_PLACEHOLDER = "ollama"  # OpenAI SDK требует непустой ключ; локальные серверы без авторизации его игнорируют

MODES = ("native", "tool", "prompt")
_CAPS: dict[tuple[str, str, str], str] = {}  # (провайдер, base_url, модель) → первый рабочий режим JSON
_CAPS_LOCK = threading.Lock()
TOOL_NAME = "submit_result"


class LLMError(RuntimeError):
    pass


class LLMConfigError(LLMError):
    pass


@dataclass
class Reply:
    text: str
    truncated: bool = False  # ответ обрезан лимитом токенов (finish_reason=length / max_tokens)


# ---------------------------------------------------------------- вспомогательное


def resolve_api_key(cfg: ProviderConfig) -> str | None:
    if cfg.api_key is not None and cfg.api_key.get_secret_value().strip():
        return cfg.api_key.get_secret_value().strip()
    return None


def inline_schema(schema: type[BaseModel], *, strict_objects: bool = False) -> dict[str, Any]:
    """JSON Schema модели без $ref/$defs и служебных полей; все свойства обязательны.
    `strict_objects` — добавить `additionalProperties: false` каждому объекту (требование Anthropic/OpenAI strict)."""
    raw = schema.model_json_schema()
    defs = raw.pop("$defs", {})

    def walk(node: Any) -> Any:
        if isinstance(node, dict):
            if "$ref" in node:
                name = node["$ref"].rsplit("/", 1)[-1]
                return walk({**defs[name], **{k: v for k, v in node.items() if k != "$ref"}})
            out = {k: walk(v) for k, v in node.items() if k not in ("title", "default", "examples")}
            if out.get("type") == "object" and "properties" in out:
                out.setdefault("required", list(out["properties"].keys()))
                if strict_objects:
                    out["additionalProperties"] = False
            return out
        if isinstance(node, list):
            return [walk(v) for v in node]
        return node

    return walk(raw)


_THINK_RE = re.compile(r"<(think|thinking|reasoning)>.*?</\1>", re.S | re.I)


def strip_reasoning(text: str) -> str:
    """Убирает рассуждения модели из текста ответа: `<think>…</think>` и незакрытый `<think>` в начале."""
    text = _THINK_RE.sub("", text or "")
    m = re.match(r"\s*<(think|thinking|reasoning)>", text, re.I)
    if m:  # рассуждение не закрыто — ответа после него нет, либо он после последнего закрывающего тега
        close = re.search(r"</(think|thinking|reasoning)>", text, re.I)
        text = text[close.end():] if close else ""
    return text.strip()


def extract_json(raw: str) -> str:
    """Достаёт JSON-объект из ответа модели (снимает рассуждения, ```json-ограждения и текст вокруг)."""
    s = strip_reasoning(raw)
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


def _is_bad_request(e: BaseException) -> bool:
    return _status_of(e) in (400, 422) or "badrequest" in type(e).__name__.lower()


_CAPABILITY_MARKERS = {
    "native": ("response_format", "json_schema", "output_config", "response_json_schema", "response_schema",
               "structured output", "output_format", "schema"),
    "tool": ("tool_choice", "tools", "tool use", "function", "tool_use"),
}


def capability_rejected(e: BaseException, mode: str) -> bool:
    """400 из-за неподдерживаемой возможности текущего режима (а не из-за содержимого запроса)."""
    if not _is_bad_request(e):
        return False
    msg = str(e).lower()
    return any(m in msg for m in _CAPABILITY_MARKERS.get(mode, ()))


def schema_instruction(schema: dict) -> str:
    return (
        "\n\nОтвет — только JSON-объект по этой JSON Schema (без markdown, пояснений и рассуждений в ответе):\n"
        + json.dumps(schema, ensure_ascii=False)
    )


TOOL_INSTRUCTION = (
    f"\n\nОбязательно передай результат, вызвав инструмент `{TOOL_NAME}` ровно один раз; "
    "аргументы — по его схеме. Текстом ответ не дублируй."
)


# ---------------------------------------------------------------- базовый клиент


class BaseLLM:
    provider: str = "base"
    json_attempts = 3
    supported_modes: tuple[str, ...] = MODES

    def __init__(self, cfg: ProviderConfig):
        self.cfg = cfg
        self.model = cfg.model
        self.usage = Usage()
        self._lock = threading.Lock()
        self._last_call = 0.0
        self.min_interval = float(cfg.min_interval_s or 0)
        self.max_attempts = int(cfg.max_attempts or 1)
        self.sleep: Callable[[float], None] = time.sleep
        # Вызывается перед каждым отрезком паузы (≤5 с) при повторе; исключение из него прерывает вызов.
        self.on_wait: Callable[[str], None] | None = None
        # Доп. поля тела запроса (OpenAI SDK / Anthropic SDK `extra_body`), напр. chat_template_kwargs у vLLM.
        # Рецензенты набора подменяют его на cfg.extra_body_set_review (см. use_extra_body) — только в своём потоке:
        # инспектор и рецензенты работают параллельно в одном пуле.
        self.extra_body: dict[str, Any] | None = getattr(cfg, "extra_body", None)
        self._extra_tl = threading.local()

    def use_extra_body(self, body: dict[str, Any] | None):
        """Контекст: другой extra_body для вызовов из текущего потока (None — не менять)."""
        client = self

        class _Ctx:
            def __enter__(self):
                self.prev = getattr(client._extra_tl, "body", None)
                if body is not None:
                    client._extra_tl.body = body
                return client

            def __exit__(self, *exc):
                client._extra_tl.body = self.prev
                return False

        return _Ctx()

    def _merged_extra(self, own: dict[str, Any] | None = None) -> dict[str, Any] | None:
        base = getattr(self._extra_tl, "body", None) or self.extra_body
        if not base and not own:
            return None
        out = dict(base or {})
        for k, v in (own or {}).items():
            out[k] = {**out[k], **v} if isinstance(out.get(k), dict) and isinstance(v, dict) else v
        return out

    # --- реализуют провайдеры
    def _call(self, system: str, messages: list[dict[str, str]], schema: tuple[str, dict] | None,
              mode: str, max_tokens: int | None) -> Reply | str:
        raise NotImplementedError

    def _stream(self, system: str, messages: list[dict[str, str]]) -> Iterator[str]:
        yield self._reply(self._call(system, messages, None, "prompt", self.max_tokens())).text

    # --- общая логика
    @staticmethod
    def _reply(r: Reply | str) -> Reply:
        return r if isinstance(r, Reply) else Reply(r)

    def max_tokens(self) -> int | None:
        return self.cfg.max_output_tokens or DEFAULT_MAX_TOKENS.get(self.cfg.provider)

    def _cap_key(self) -> tuple[str, str, str]:
        return (self.cfg.provider.value, self.cfg.base_url or "", self.model)

    def json_mode(self) -> str:
        with _CAPS_LOCK:
            mode = _CAPS.get(self._cap_key())
        return mode if mode in self.supported_modes else self.supported_modes[0]

    def _downgrade(self, mode: str, e: BaseException) -> str | None:
        modes = self.supported_modes
        nxt = modes[modes.index(mode) + 1] if mode in modes and modes.index(mode) + 1 < len(modes) else None
        if nxt:
            log.warning("%s/%s: режим JSON «%s» не поддержан (%s) → «%s»", self.provider, self.model, mode,
                        str(e)[:200], nxt)
            with _CAPS_LOCK:
                _CAPS[self._cap_key()] = nxt
        return nxt

    def add_usage(self, prompt: int | None, completion: int | None) -> None:
        with self._lock:
            self.usage.llm_calls += 1
            self.usage.prompt_tokens += int(prompt or 0)
            self.usage.completion_tokens += int(completion or 0)

    def _pause(self, seconds: float, reason: str) -> None:
        left = seconds
        while left > 0:
            if self.on_wait:
                self.on_wait(f"{reason}: повтор через {left:.0f} с")
            step = min(5.0, left)
            self.sleep(step)
            left -= step

    def _throttle(self) -> None:
        if self.min_interval <= 0:
            return
        with self._lock:
            wait = self._last_call + self.min_interval - time.monotonic()
            self._last_call = max(time.monotonic(), self._last_call + self.min_interval)
        if wait > 0:
            self._pause(wait, "Пауза между запросами")

    def _with_retry(self, fn: Callable[[], Reply | str]) -> Reply:
        delay = 2.0
        for attempt in range(1, self.max_attempts + 1):
            self._throttle()
            try:
                return self._reply(fn())
            except Exception as e:  # noqa: BLE001 — классифицируем ниже
                if attempt >= self.max_attempts or not is_retryable(e):
                    raise
                wait = min(retry_after_seconds(e) or delay, 90.0) + random.uniform(0, 1.0)
                log.warning("LLM %s: %s; повтор %d/%d через %.0f с", self.provider, type(e).__name__,
                            attempt, self.max_attempts, wait)
                self._pause(wait, "Лимит запросов провайдера" if _status_of(e) == 429 else "Провайдер недоступен")
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
        msgs = [{"role": "user", "content": user}]
        reply = self._with_retry(lambda: self._call(system, msgs, None, "prompt", self.max_tokens()))
        return strip_reasoning(reply.text)

    def complete_reply(self, system: str, user: str, max_tokens: int | None = None, *, name: str | None = None
                       ) -> Reply:
        """Текстовый ответ с признаком обрыва — для агентов, которые сами разбирают JSON (req_core.agent).
        name — имя промта (для журналов)."""
        msgs = [{"role": "user", "content": user}]
        limit = max_tokens or self.max_tokens()
        reply = self._with_retry(lambda: self._call(system, msgs, None, "prompt", limit))
        return Reply(strip_reasoning(reply.text) if not reply.truncated else reply.text, reply.truncated)

    def _call_json(self, system: str, msgs: list[dict[str, str]], sch: tuple[str, dict], limit: int | None
                   ) -> Reply:
        """Один логический вызов со спуском по цепочке режимов при отказе по возможностям."""
        mode = self.json_mode()
        while True:
            try:
                return self._with_retry(lambda m=mode: self._call(system, msgs, sch, m, limit))
            except Exception as e:  # noqa: BLE001
                if not capability_rejected(e, mode):
                    raise
                nxt = self._downgrade(mode, e)
                if not nxt:
                    raise
                mode = nxt

    def complete_json(self, system: str, user: str, schema: type[T]) -> T:
        sch = (schema.__name__, inline_schema(schema))
        prompt = user
        limit = self.max_tokens()
        last: Exception | None = None
        for _ in range(self.json_attempts):
            reply = self._call_json(system, [{"role": "user", "content": prompt}], sch, limit)
            try:
                return schema.model_validate_json(extract_json(reply.text))
            except (ValidationError, ValueError) as e:
                last = e
                if reply.truncated and (limit or 0) < MAX_TOKENS_CEILING:
                    limit = min(limit * 2 if limit else 65_536, MAX_TOKENS_CEILING)
                    log.warning("LLM %s: JSON обрезан лимитом токенов — повтор с лимитом %d", self.provider, limit)
                    continue
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
                for chunk in _ThinkFilter().feed_all(self._stream(system, msgs)):
                    started = True
                    if chunk:
                        yield chunk
                return
            except Exception as e:  # noqa: BLE001
                if started or attempt >= self.max_attempts or not is_retryable(e):
                    raise
                self._pause(min(retry_after_seconds(e) or 2.0 * attempt, 60.0), "Повтор запроса")

    def list_models(self) -> list[str]:
        return []


class _ThinkFilter:
    """Вырезает `<think>…</think>` из потока токенов чата."""

    def __init__(self) -> None:
        self.buf = ""
        self.inside = False

    def feed_all(self, chunks: Iterator[str]) -> Iterator[str]:
        for c in chunks:
            out = self.feed(c or "")
            if out:
                yield out
        if not self.inside and self.buf:
            yield self.buf

    def feed(self, chunk: str) -> str:
        self.buf += chunk
        out = ""
        while True:
            if self.inside:
                m = re.search(r"</(think|thinking|reasoning)>", self.buf, re.I)
                if not m:
                    self.buf = self.buf[-20:]
                    return out
                self.buf, self.inside = self.buf[m.end():].lstrip(), False
            else:
                m = re.search(r"<(think|thinking|reasoning)>", self.buf, re.I)
                if m:
                    out += self.buf[: m.start()]
                    self.buf, self.inside = self.buf[m.end():], True
                    continue
                # хвост может оказаться началом тега — придерживаем его
                cut = self.buf.rfind("<")
                if cut >= 0 and len(self.buf) - cut < 12:
                    out += self.buf[:cut]
                    self.buf = self.buf[cut:]
                else:
                    out += self.buf
                    self.buf = ""
                return out


# ---------------------------------------------------------------- Gemini (google-genai)


class GeminiLLM(BaseLLM):
    provider = "gemini"
    supported_modes = ("native", "prompt")

    def __init__(self, cfg: ProviderConfig):
        super().__init__(cfg)
        from google import genai
        from google.genai import types

        key = resolve_api_key(cfg)
        if not key:
            raise LLMConfigError("Не задан ключ Gemini (получить: https://aistudio.google.com/)")
        self._types = types
        http = {"timeout": int(cfg.timeout_s * 1000)}
        if cfg.base_url:
            http["base_url"] = cfg.base_url
        self.client = genai.Client(api_key=key, http_options=types.HttpOptions(**http))

    def _contents(self, messages: list[dict[str, str]]):
        t = self._types
        return [
            t.Content(role="model" if m["role"] == "assistant" else "user", parts=[t.Part(text=m["content"])])
            for m in messages
        ]

    def _config(self, system: str, schema: tuple[str, dict] | None, mode: str, max_tokens: int | None):
        kw: dict[str, Any] = {"system_instruction": system, "temperature": self.cfg.temperature}
        if max_tokens:
            kw["max_output_tokens"] = max_tokens
        if schema:
            kw["response_mime_type"] = "application/json"
            if mode == "native":
                kw["response_json_schema"] = schema[1]
            else:
                kw["system_instruction"] = system + schema_instruction(schema[1])
        return self._types.GenerateContentConfig(**kw)

    @staticmethod
    def _text(resp) -> str:
        """Текст ответа без «мыслей» (part.thought)."""
        try:
            parts = resp.candidates[0].content.parts or []
            return "".join(p.text for p in parts if getattr(p, "text", None) and not getattr(p, "thought", False))
        except (AttributeError, IndexError, TypeError):
            return resp.text or ""

    def _call(self, system, messages, schema, mode, max_tokens):
        resp = self.client.models.generate_content(
            model=self.model, contents=self._contents(messages), config=self._config(system, schema, mode, max_tokens)
        )
        um = getattr(resp, "usage_metadata", None)
        self.add_usage(
            getattr(um, "prompt_token_count", 0),
            (getattr(um, "candidates_token_count", 0) or 0) + (getattr(um, "thoughts_token_count", 0) or 0),
        )
        reason = ""
        try:
            reason = str(resp.candidates[0].finish_reason)
        except (AttributeError, IndexError, TypeError):
            pass
        truncated = "MAX_TOKENS" in reason
        text = self._text(resp)
        if not text and not truncated:
            raise LLMError(f"Gemini вернул пустой ответ {reason}".strip())
        return Reply(text, truncated)

    def _stream(self, system, messages):
        last_um = None
        for chunk in self.client.models.generate_content_stream(
            model=self.model, contents=self._contents(messages), config=self._config(system, None, "prompt", None)
        ):
            last_um = getattr(chunk, "usage_metadata", None) or last_um
            text = self._text(chunk)
            if text:
                yield text
        self.add_usage(getattr(last_um, "prompt_token_count", 0), getattr(last_um, "candidates_token_count", 0))

    def list_models(self) -> list[str]:
        out = []
        for m in self.client.models.list():
            name = (m.name or "").removeprefix("models/")
            actions = getattr(m, "supported_actions", None) or []
            if "generateContent" not in actions:
                continue
            out.append(name)
        return sorted(set(out))


# ---------------------------------------------------------------- OpenAI и OpenAI-совместимые


_OPENAI_CHAT = re.compile(r"^(gpt-|o\d|chatgpt-)", re.I)
_OPENAI_NOT_CHAT = ("embedding", "tts", "whisper", "dall-e", "image", "audio", "realtime", "transcribe",
                    "moderation", "search", "computer-use", "codex")


class OpenAILLM(BaseLLM):
    provider = "openai"

    def __init__(self, cfg: ProviderConfig):
        super().__init__(cfg)
        from openai import OpenAI

        self.compatible = cfg.provider == ProviderName.OPENAI_COMPATIBLE
        self.provider = cfg.provider.value
        key = resolve_api_key(cfg)
        if self.compatible and not cfg.base_url:
            raise LLMConfigError("Для openai_compatible нужен base_url (адрес OpenAI-совместимого сервера, …/v1)")
        if not key:
            if not self.compatible:
                raise LLMConfigError("Не задан ключ OpenAI")
            key = NO_KEY_PLACEHOLDER
        self.client = OpenAI(api_key=key, base_url=cfg.base_url, timeout=cfg.timeout_s, max_retries=0)
        self._use_temperature = True

    def _kwargs(self, system, messages, schema, mode, max_tokens):
        sys_text = system
        kw: dict[str, Any] = {"model": self.model}
        if self._use_temperature:
            kw["temperature"] = self.cfg.temperature
        if max_tokens:
            kw["max_tokens" if self.compatible else "max_completion_tokens"] = max_tokens
        if schema:
            if mode == "native":
                kw["response_format"] = {
                    "type": "json_schema",
                    "json_schema": {"name": schema[0], "schema": schema[1], "strict": False},
                }
            elif mode == "tool":
                kw["tools"] = [{"type": "function", "function": {
                    "name": TOOL_NAME, "description": "Передать результат строго по схеме.", "parameters": schema[1]}}]
                kw["tool_choice"] = "auto"
                sys_text = system + TOOL_INSTRUCTION
            else:
                sys_text = system + schema_instruction(schema[1])
        kw["messages"] = [{"role": "system", "content": sys_text}, *messages]
        extra = self._merged_extra()
        if extra:
            kw["extra_body"] = extra
        return kw

    def _create(self, **kw):
        try:
            return self.client.chat.completions.create(**kw)
        except Exception as e:
            if _is_bad_request(e) and "temperature" in str(e).lower() and self._use_temperature:
                self._use_temperature = False
                kw.pop("temperature", None)
                return self.client.chat.completions.create(**kw)
            raise

    def _call(self, system, messages, schema, mode, max_tokens):
        resp = self._create(**self._kwargs(system, messages, schema, mode, max_tokens))
        u = getattr(resp, "usage", None)
        self.add_usage(getattr(u, "prompt_tokens", 0), getattr(u, "completion_tokens", 0))
        if not resp.choices:
            raise LLMError(f"{self.provider} вернул ответ без choices")
        choice = resp.choices[0]
        truncated = choice.finish_reason == "length"
        msg = choice.message
        text = msg.content or ""  # поля reasoning / reasoning_content намеренно не читаем
        for tc in getattr(msg, "tool_calls", None) or []:
            fn = getattr(tc, "function", None)
            if fn is not None and fn.name == TOOL_NAME and fn.arguments:
                text = fn.arguments
                break
        if not text.strip() and not truncated:
            raise LLMError(f"{self.provider} вернул пустой ответ (finish_reason={choice.finish_reason})")
        return Reply(text, truncated)

    def _stream(self, system, messages):
        stream = self._create(**self._kwargs(system, messages, None, "prompt", self.max_tokens()), stream=True)
        for ev in stream:
            if ev.choices and ev.choices[0].delta and ev.choices[0].delta.content:
                yield ev.choices[0].delta.content
        self.add_usage(0, 0)

    def list_models(self) -> list[str]:
        ids = sorted({m.id for m in self.client.models.list()})
        if self.compatible:
            return ids
        return [i for i in ids if _OPENAI_CHAT.match(i) and not any(x in i for x in _OPENAI_NOT_CHAT)]


# ---------------------------------------------------------------- Anthropic

# Модели без temperature/top_p (400 на любое значение) — для них параметр не отправляем вовсе.
_ANTHROPIC_NO_SAMPLING = re.compile(r"claude-(fable|mythos)|claude-(opus|sonnet|haiku)-5|claude-opus-4-[78]", re.I)


class AnthropicLLM(BaseLLM):
    provider = "anthropic"

    def __init__(self, cfg: ProviderConfig):
        super().__init__(cfg)
        import anthropic

        key = resolve_api_key(cfg)
        if not key:
            raise LLMConfigError("Не задан ключ Anthropic")
        self.client = anthropic.Anthropic(api_key=key, base_url=cfg.base_url, timeout=cfg.timeout_s, max_retries=0)
        self._use_temperature = not _ANTHROPIC_NO_SAMPLING.search(self.model or "")

    def _kwargs(self, system, messages, max_tokens):
        kw: dict[str, Any] = {
            "model": self.model,
            "max_tokens": max_tokens or DEFAULT_MAX_TOKENS[ProviderName.ANTHROPIC],
            "system": system,
            "messages": messages,
        }
        if self._use_temperature:
            kw["temperature"] = self.cfg.temperature
        extra = self._merged_extra()
        if extra:
            kw["extra_body"] = extra
        return kw

    def _request(self, kw: dict[str, Any]):
        """Потоковый запрос (большие max_tokens без таймаутов SDK) → итоговое сообщение."""
        with self.client.messages.stream(**kw) as s:
            return s.get_final_message()

    def _call(self, system, messages, schema, mode, max_tokens):
        kw = self._kwargs(system, messages, max_tokens)
        if schema:
            strict = inline_schema_strict(schema)
            if mode == "native":
                kw["extra_body"] = self._merged_extra(
                    {"output_config": {"format": {"type": "json_schema", "schema": strict}}})
            elif mode == "tool":
                kw["tools"] = [{"name": TOOL_NAME, "description": "Передать результат строго по схеме.",
                                "input_schema": strict}]
                kw["tool_choice"] = {"type": "auto"}  # принудительный tool_choice новые модели отклоняют
                kw["system"] = system + TOOL_INSTRUCTION
            else:
                kw["system"] = system + schema_instruction(schema[1])
        try:
            resp = self._request(kw)
        except Exception as e:
            if _is_bad_request(e) and "temperature" in str(e).lower() and self._use_temperature:
                self._use_temperature = False
                return self._call(system, messages, schema, mode, max_tokens)
            raise
        u = getattr(resp, "usage", None)
        self.add_usage(getattr(u, "input_tokens", 0), getattr(u, "output_tokens", 0))
        stop = getattr(resp, "stop_reason", None)
        if stop == "refusal":
            raise LLMError("Anthropic: модель отказалась отвечать (stop_reason=refusal)")
        truncated = stop == "max_tokens"
        for block in resp.content:
            if getattr(block, "type", "") == "tool_use" and getattr(block, "name", "") == TOOL_NAME:
                return Reply(json.dumps(block.input, ensure_ascii=False), truncated)
        text = "".join(getattr(b, "text", "") for b in resp.content if getattr(b, "type", "") == "text")
        if not text and not truncated:
            raise LLMError(f"Anthropic вернул пустой ответ (stop_reason={stop})")
        return Reply(text, truncated)

    def _stream(self, system, messages):
        kw = self._kwargs(system, messages, self.max_tokens())
        with self.client.messages.stream(**kw) as s:
            yield from s.text_stream
            final = s.get_final_message()
        u = getattr(final, "usage", None)
        self.add_usage(getattr(u, "input_tokens", 0), getattr(u, "output_tokens", 0))

    def list_models(self) -> list[str]:
        return [m.id for m in self.client.models.list(limit=100)]


_STRICT_CACHE: dict[str, dict] = {}


def inline_schema_strict(schema: tuple[str, dict]) -> dict:
    """Схема с `additionalProperties: false` у каждого объекта (требование structured outputs Anthropic)."""
    name, sch = schema
    if name not in _STRICT_CACHE:
        def walk(node: Any) -> Any:
            if isinstance(node, dict):
                out = {k: walk(v) for k, v in node.items()}
                if out.get("type") == "object":
                    out["additionalProperties"] = False
                return out
            if isinstance(node, list):
                return [walk(v) for v in node]
            return node
        _STRICT_CACHE[name] = walk(sch)
    return _STRICT_CACHE[name]


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
    if available:
        return available[0] if not prefs else prefs[0]
    return prefs[0] if prefs else None


def create_llm(cfg: ProviderConfig) -> BaseLLM:
    client = _CLASSES[cfg.provider](cfg)
    if not client.model:
        try:
            available = client.list_models()
        except Exception as e:  # noqa: BLE001
            log.warning("Не удалось получить список моделей %s: %s", cfg.provider.value, e)
            available = []
        model = choose_model(cfg.provider, available)
        if not model:
            raise LLMConfigError(f"Не указана модель для {cfg.provider.value}")
        client.model = model
        client.cfg = cfg.model_copy(update={"model": model})
        if isinstance(client, AnthropicLLM):
            client._use_temperature = not _ANTHROPIC_NO_SAMPLING.search(model)
    return client


def list_provider_models(cfg: ProviderConfig) -> list[str]:
    """Живой список моделей у провайдера по ключу и base_url из конфига (без запасных списков)."""
    client = _CLASSES[cfg.provider](cfg.model_copy(update={"model": cfg.model or "list"}))
    return client.list_models()
