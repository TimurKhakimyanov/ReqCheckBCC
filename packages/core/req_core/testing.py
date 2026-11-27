"""Детерминированный фейковый LLM для тестов (ядро, воркер, API). В сеть не ходит.

По умолчанию возвращает «пустые» ответы по схеме (все поля LLM-схем имеют значения по умолчанию) —
тогда конвейер работает только на детерминированных правилах. Сценарий задаётся словарём
`{имя схемы: ответ | функция(system, user) -> ответ}`; ответ — dict, Pydantic-модель или JSON-строка.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Iterator
from typing import Any

from pydantic import BaseModel
from req_contracts import ProviderConfig, ProviderName, Usage

Responder = Callable[[str, str], Any]


class FakeLLM:
    provider = "fake"

    def __init__(
        self,
        responses: dict[str, Any | Responder] | None = None,
        *,
        text: str = "Ответ FakeLLM по отчёту.",
        model: str = "fake-model",
    ):
        self.responses = responses or {}
        self.text = text
        self.model = model
        self.cfg = ProviderConfig(provider=ProviderName.OPENAI_COMPATIBLE, model=model, base_url="http://fake")
        self.usage = Usage()
        self.calls: list[dict[str, Any]] = []
        self.context_window = 200_000  # окно модели для контроля контекста агентов

    def _count(self, system: str, user: str, out: str) -> None:
        self.usage.llm_calls += 1
        self.usage.prompt_tokens += (len(system) + len(user)) // 4
        self.usage.completion_tokens += len(out) // 4

    def complete(self, system: str, user: str) -> str:
        self.calls.append({"kind": "complete", "system": system, "user": user})
        self._count(system, user, self.text)
        return self.text

    def complete_json(self, system: str, user: str, schema: type[BaseModel]) -> BaseModel:
        self.calls.append({"kind": "json", "schema": schema.__name__, "system": system, "user": user})
        resp = self.responses.get(schema.__name__)
        if callable(resp) and not isinstance(resp, BaseModel):
            resp = resp(system, user)
        if resp is None:
            result = schema.model_validate({})
        elif isinstance(resp, BaseModel):
            result = schema.model_validate(resp.model_dump())
        elif isinstance(resp, str):
            result = schema.model_validate_json(resp)
        else:
            result = schema.model_validate(resp)
        self._count(system, user, json.dumps(result.model_dump(mode="json"), ensure_ascii=False))
        return result

    def complete_reply(self, system: str, user: str, max_tokens: int | None = None, *, name: str | None = None):
        """Ответ агенту req_core.agent: сценарий по имени промта (`inspector`, `reviewer`, `verifier`, `dedup`,
        `extractor`, `extractor_gaps`, `clarifier`, `checklist`, `verdict`, `resolver`); по умолчанию «{}»."""
        from .llm import Reply

        self.calls.append({"kind": "agent", "prompt": name, "system": system, "user": user})
        resp = self.responses.get(name or "")
        if callable(resp) and not isinstance(resp, BaseModel):
            resp = resp(system, user)
        if resp is None:
            out = "{}"
        elif isinstance(resp, str):
            out = resp
        elif isinstance(resp, BaseModel):
            out = resp.model_dump_json()
        else:
            out = json.dumps(resp, ensure_ascii=False)
        self._count(system, user, out)
        return Reply(out)

    def stream(self, system: str, messages: list[Any]) -> Iterator[str]:
        self.calls.append({"kind": "stream", "system": system, "messages": messages})
        self._count(system, "", self.text)
        for i, word in enumerate(self.text.split(" ")):
            yield word if i == 0 else " " + word

    def list_models(self) -> list[str]:
        return [self.model]
