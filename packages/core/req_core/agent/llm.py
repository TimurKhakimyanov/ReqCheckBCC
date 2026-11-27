"""Вызов модели для агентов bbc-agent поверх клиентов ReqCheck (OpenAI-совместимые, Anthropic, Gemini, FakeLLM).

Агенты ждут свободный JSON по схеме, описанной в промте (`ctx.llm.json(...)` → dict/list). Здесь:
  - контроль окна модели до вызова (Budget.check → ContextOverflow, запрос не отправляется);
  - лимит ответа и повтор с удвоенным лимитом при обрыве; спасение оборванного JSON (salvage_json);
  - повтор с пояснением, если ответ не разобрался как JSON;
  - фрагменты базы знаний (RAG) в системный промт;
  - отмена прогона и фатальные ошибки провайдера (ключ, модель) — как BaseException, чтобы их не
    проглотили `except Exception` внутри агентов (там они означают «этот интент не удался, повторим»);
  - кэш ответов модели, как в bbc-agent: каталог из переменной LLM_CACHE_DIR, ключ — провайдер, адрес, модель,
    температура, параметры запроса, системный промпт и запрос. Повторный прогон того же документа с теми же
    настройками берёт ответы из кэша и проходит за секунды; изменение модели, промпта или базы знаний — новый ключ.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import threading
from pathlib import Path
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
    ask = getattr(client, "server_context_window", None)
    if ask is not None:  # как в bbc-agent: vLLM отдаёт max_model_len, Gemini — лимиты модели
        n = ask()
        if n:
            return int(n), "сообщил сервер"
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
        self.tokens_in = self.tokens_out = self.calls = self.cache_hits = 0
        self._lock = threading.Lock()
        cache = (os.getenv("LLM_CACHE_DIR") or "").strip()
        self.cache_dir = Path(cache) if cache and getattr(client, "cfg", None) is not None else None

    # --- кэш ответов (validator/llm.py bbc-agent: _cache_key, _cache_get, _cache_put)
    def _cache_key(self, role: str, system: str, user: str) -> str:
        cfg = self.client.cfg
        body = getattr(cfg, "extra_body_set_review", None) if role == "reviewer" else None
        extra = body if body is not None else (getattr(cfg, "extra_body", None) or {})
        h = hashlib.sha256()
        provider = str(getattr(cfg.provider, "value", cfg.provider))
        for part in (provider, cfg.base_url or "", getattr(self.client, "model", ""), str(cfg.temperature),
                     json.dumps(extra, sort_keys=True, ensure_ascii=False), system, user):
            h.update(part.encode("utf-8"))
            h.update(b"\x00")
        return h.hexdigest()

    def _cache_get(self, key: str) -> dict | None:
        if self.cache_dir is None:
            return None
        p = self.cache_dir / f"{key}.json"
        try:
            val = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        return val if isinstance(val, dict) and val.get("_v") == 2 and "data" in val else None

    def _cache_put(self, key: str, data: Any, t_in: int, t_out: int) -> None:
        if self.cache_dir is None:
            return
        try:
            self.cache_dir.mkdir(parents=True, exist_ok=True)
            # через временный файл: параллельные прогоны не увидят наполовину записанный ответ
            tmp = self.cache_dir / f"{key}.{threading.get_ident()}.tmp"
            tmp.write_text(json.dumps({"_v": 2, "data": data, "usage": {"in": t_in, "out": t_out}}, ensure_ascii=False),
                           encoding="utf-8")
            os.replace(tmp, self.cache_dir / f"{key}.json")
        except OSError:
            pass  # кэш — ускорение, не обязательная часть прогона

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
        key = self._cache_key(role, system, user) if self.cache_dir is not None else ""
        cached = self._cache_get(key) if key else None
        if cached is not None:
            usage = cached.get("usage") or {}
            with self._lock:
                self.cache_hits += 1
            self.budget.observe(len(system) + len(user), int(usage.get("in", 0) or 0), who)
            self.on_activity({"kind": "llm_call", "agent": role, "label": label, "prompt": name, "cached": True,
                              "tokens_in": int(usage.get("in", 0) or 0), "tokens_out": int(usage.get("out", 0) or 0),
                              "est": est, "attempt": 0, "truncated": False})
            return cached["data"]
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
                    if key:
                        self._cache_put(key, partial, t_in, t_out)
                    return partial  # модель выдала много целых элементов и оборвалась на очередном
                limit = min(limit * 2, max(self.budget.window - est - 512, limit))
                continue
            try:
                data = parse_json(reply.text)
            except (ValueError, json.JSONDecodeError) as e:
                last_err = str(e)
                text_prompt = (user + "\n\nВАЖНО: предыдущий ответ не удалось разобрать как JSON (" + last_err
                               + "). Верни ТОЛЬКО валидный JSON по заданной схеме, без пояснений и без ```.")
                continue
            if key:
                self._cache_put(key, data, t_in, t_out)
            return data
        raise LLMError(f"[{who}] не удалось получить JSON за 3 попытки: {last_err}")
