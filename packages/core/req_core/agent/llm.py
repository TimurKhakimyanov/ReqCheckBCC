"""Вызов модели для агентов bbc-agent поверх клиентов ReqCheck (OpenAI-совместимые, Anthropic, Gemini, FakeLLM).

Агенты ждут свободный JSON по схеме, описанной в промте (`ctx.llm.json(...)` → dict/list). Здесь:
  - контроль окна модели до вызова (Budget.check → ContextOverflow, запрос не отправляется);
  - лимит ответа и повтор с удвоенным лимитом при обрыве; спасение оборванного JSON (salvage_json);
  - повтор с пояснением, если ответ не разобрался как JSON;
  - фрагменты базы знаний (RAG) в системный промт;
  - отмена прогона и фатальные ошибки провайдера (ключ, модель) — как BaseException, чтобы их не
    проглотили `except Exception` внутри агентов (там они означают «этот интент не удался, повторим»).
"""

from __future__ import annotations

import json
import re
import threading
from typing import Any

from .budget import Budget

KB_ROLES = ("inspector", "reviewer", "verifier", "clarifier", "reporter")


class LLMError(RuntimeError):
    pass


class LLMTruncated(LLMError):
    """Ответ оборван лимитом токенов; text — то, что модель успела выдать."""

    def __init__(self, msg: str, text: str = ""):
        super().__init__(msg)
        self.text = text


class Stop(BaseException):  # noqa: N818 — служебный сигнал, а не ошибка
    """Прервать прогон: отмена из on_progress или фатальная ошибка провайдера. `cause` — исходное исключение."""

    def __init__(self, cause: BaseException):
        super().__init__(str(cause))
        self.cause = cause


_THINK_RE = re.compile(r"<(think|thinking|reasoning)>.*?</\1>", re.S | re.I)
_FENCE_RE = re.compile(r"^```[a-zA-Z]*\s*|\s*```$", re.M)


def parse_json(text: str) -> Any:
    """Достаёт JSON из ответа модели: убирает размышления, ```-ограждения и текст вокруг."""
    if text is None:
        raise ValueError("пустой ответ")
    t = _THINK_RE.sub("", text).strip()
    t = _FENCE_RE.sub("", t).strip()
    try:
        return json.loads(t)
    except json.JSONDecodeError:
        pass
    starts = [i for i in (t.find("{"), t.find("[")) if i != -1]
    if not starts:
        raise ValueError("в ответе нет JSON")
    start = min(starts)
    end = max(t.rfind("}"), t.rfind("]"))
    if end <= start:
        raise ValueError("JSON оборван")
    return json.loads(t[start:end + 1])


def salvage_json(text: str) -> Any:
    """Спасает оборванный JSON: отбрасывает незаконченный хвост и закрывает открытые скобки."""
    t = _FENCE_RE.sub("", _THINK_RE.sub("", text or "")).strip()
    start = min((i for i in (t.find("{"), t.find("[")) if i != -1), default=-1)
    if start == -1:
        return None
    stack: list[str] = []
    in_str = esc = False
    last_good, good_stack = -1, []
    for i in range(start, len(t)):
        ch = t[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch in "{[":
            stack.append("}" if ch == "{" else "]")
        elif ch in "}]":
            if not stack:
                break
            stack.pop()
            last_good, good_stack = i, list(stack)
            if not stack:
                break
    if last_good == -1:
        return None
    body = t[start:last_good + 1].rstrip().rstrip(",")
    try:
        return json.loads(body + "".join(reversed(good_stack)))
    except json.JSONDecodeError:
        return None


def detect_window(client: Any) -> tuple[int, str]:
    """Окно модели: из настроек (ProviderConfig.context_tokens) или оценка по провайдеру и модели."""
    own = getattr(client, "context_window", None)
    if own:
        return int(own), "клиент"
    cfg = getattr(client, "cfg", None)
    if cfg is not None and getattr(cfg, "context_tokens", None):
        return int(cfg.context_tokens), "настройки провайдера"
    provider = str(getattr(getattr(cfg, "provider", None), "value", getattr(cfg, "provider", "")) or "")
    model = (getattr(client, "model", "") or "").lower()
    if provider == "anthropic" or model.startswith("claude"):
        return 200_000, "по умолчанию для Anthropic"
    if provider == "gemini" or model.startswith("gemini"):
        return 1_000_000, "по умолчанию для Gemini"
    if provider == "openai":
        if model.startswith("gpt-4.1"):
            return 1_000_000, "по умолчанию для модели"
        if model.startswith(("gpt-5", "o3", "o4")):
            return 200_000, "по умолчанию для модели"
        return 128_000, "по умолчанию для OpenAI"
    return 32_000, "по умолчанию (размер окна не задан; укажите context_tokens у провайдера)"


def _fatal(e: BaseException) -> bool:
    from ..llm import LLMConfigError, _status_of

    return isinstance(e, LLMConfigError) or _status_of(e) in (401, 403, 404)


class AgentLLM:
    def __init__(self, client: Any, *, knowledge: list[str] | None = None, progress: Any = None,
                 on_activity: Any = None):
        self.client = client
        window, source = detect_window(client)
        max_out = None
        try:
            max_out = client.max_tokens()
        except Exception:  # noqa: BLE001 — у фейкового клиента метода нет
            max_out = None
        self.max_output = int(max_out or 16_000)
        self.budget = Budget(window=window, max_output=self.max_output, window_source=source)
        self.knowledge = [k.strip() for k in (knowledge or []) if k and k.strip()]
        self.progress = progress
        self.on_activity = on_activity or (lambda rec: None)
        self.tokens_in = self.tokens_out = self.calls = 0
        self._lock = threading.Lock()

    def _system(self, role: str, system: str) -> str:
        if not self.knowledge or role not in KB_ROLES:
            return system
        kb = "\n\n".join(f"[{i}] {k[:3000]}" for i, k in enumerate(self.knowledge[:8], 1))
        return (system + "\n\nСПРАВОЧНЫЕ МАТЕРИАЛЫ БАЗЫ ЗНАНИЙ (стандарты, глоссарий, правила банка). Используй их "
                "как контекст для оценки; дефекты подтверждай только цитатами из проверяемого документа:\n" + kb)

    def _check_abort(self) -> None:
        aborted = getattr(self.progress, "aborted", None)
        if aborted is not None:
            raise Stop(aborted)

    def _raw(self, role: str, system: str, user: str, limit: int, name: str):
        fn = getattr(self.client, "complete_reply", None)
        if fn is None:  # клиент без сырого вызова: обычный текстовый ответ
            from ..llm import Reply

            return Reply(self.client.complete(system, user))
        # рецензенты набора — со своими параметрами запроса (напр. включённые рассуждения для поиска противоречий)
        body = getattr(getattr(self.client, "cfg", None), "extra_body_set_review", None) if role == "reviewer" else None
        use = getattr(self.client, "use_extra_body", None)
        if body is not None and use is not None:
            with use(body):
                return fn(system, user, limit, name=name)
        return fn(system, user, limit, name=name)

    def json(self, role: str, system: str, user: str, *, label: str = "", max_tokens: int | None = None,
             grow: bool = True, prompt: str | None = None) -> Any:
        """Вызов модели с ожиданием JSON. prompt — имя промта (для журналов и сценариев FakeLLM)."""
        self._check_abort()
        system = self._system(role, system)
        who = f"{role}/{label}" if label else role
        name = prompt or role
        est = self.budget.check(system, user, who)
        limit = min(max_tokens or self.max_output, self.budget.output_reserve)
        text_prompt = user
        last_err = ""
        for attempt in range(1, 4):
            self._check_abort()
            usage = getattr(self.client, "usage", None)
            before = (getattr(usage, "prompt_tokens", 0), getattr(usage, "completion_tokens", 0))
            try:
                reply = self._raw(role, system, text_prompt, limit, name)
            except Exception as e:  # noqa: BLE001
                if self.progress is not None and getattr(self.progress, "aborted", None) is not None:
                    raise Stop(self.progress.aborted) from e
                if _fatal(e):
                    raise Stop(e) from e
                raise
            after = (getattr(usage, "prompt_tokens", 0), getattr(usage, "completion_tokens", 0))
            t_in, t_out = max(0, after[0] - before[0]), max(0, after[1] - before[1])
            with self._lock:
                self.calls += 1
                self.tokens_in += t_in
                self.tokens_out += t_out
            self.budget.observe(len(system) + len(text_prompt), t_in, who)
            self.on_activity({"kind": "llm_call", "agent": role, "label": label, "prompt": name, "tokens_in": t_in,
                              "tokens_out": t_out, "est": est, "attempt": attempt, "truncated": reply.truncated})
            if reply.truncated:
                self.budget.note_truncated()
                last_err = f"ответ обрезан по лимиту {limit} токенов"
                if not grow:
                    raise LLMTruncated(last_err, reply.text)
                partial = salvage_json(reply.text)
                if isinstance(partial, (dict, list)) and partial and len(reply.text) > 2_000:
                    return partial  # модель выдала много целых элементов и оборвалась на очередном
                limit = min(limit * 2, max(self.budget.window - est - 512, limit))
                continue
            try:
                return parse_json(reply.text)
            except (ValueError, json.JSONDecodeError) as e:
                last_err = str(e)
                text_prompt = (user + "\n\nВАЖНО: предыдущий ответ не удалось разобрать как JSON (" + last_err
                               + "). Верни ТОЛЬКО валидный JSON по заданной схеме, без пояснений и без ```.")
        raise LLMError(f"[{who}] не удалось получить JSON за 3 попытки: {last_err}")
