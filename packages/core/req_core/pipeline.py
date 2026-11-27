"""Конвейер проверки — агенты bbc-agent (req_core.agent): нарезчик (два прохода) → правила-подсказки →
планировщик и воркеры (инспектор по матрице «требование × критерий», шесть рецензентов набора, раунды до
полного покрытия) → контроль достоверности кодом → верификатор (опровержение, слияние дублей) → вопросы автору
и чек-лист → ответы автора → итог. Здесь — прогресс, отмена и вход `run_pipeline`."""

from __future__ import annotations

import logging
import threading
from typing import Any

from req_contracts import ParsedDocument, ProgressCallback, ProgressEvent, Report, RunStage, ValidationOptions

from .agent.run import TITLE_LIMIT, run_agents, split_title, strip_foreign_script

log = logging.getLogger("req_core.pipeline")

__all__ = ["Progress", "TITLE_LIMIT", "run_pipeline", "split_title", "strip_foreign_script"]


class Progress:
    """Обёртка над on_progress. Исключение из callback (отмена, таймаут воркера) НЕ глотается:
    оно запоминается в `aborted` и прерывает конвейер, даже если возникло внутри LLM-вызова."""

    def __init__(self, cb: ProgressCallback | None):
        self.cb = cb
        self.last = 0.0
        self.stage = RunStage.PARSING
        self.aborted: BaseException | None = None
        self._lock = threading.Lock()

    def __call__(self, stage: RunStage, progress: float, message: str = "", current: int | None = None,
                 total: int | None = None) -> None:
        if self.aborted is not None:
            raise self.aborted
        with self._lock:
            self.last = max(self.last, min(1.0, progress))
            self.stage = stage
            event = ProgressEvent(stage=stage, progress=self.last, message=message, current=current, total=total)
        if self.cb:
            try:
                self.cb(event)
            except BaseException as e:
                self.aborted = e
                raise

    def heartbeat(self, message: str) -> None:
        """Событие без изменения стадии — во время ожидания лимитов провайдера (даёт сработать отмене)."""
        self(self.stage, self.last, message)


def run_pipeline(doc: ParsedDocument, client: Any, *, options: ValidationOptions | None = None,
                 on_progress: ProgressCallback | None = None, provider: str = "", model: str = "",
                 interactive: bool = False, ask_author: Any = None) -> Report:
    """interactive — задать уточняющие вопросы в консоли и учесть ответы в этом же прогоне (CLI --ask).
    ask_author — то же для веба: callable(вопросы) → {Q-01: ответ}; вызывается при options.ask_author."""
    progress = Progress(on_progress)
    try:  # клиент LLM сообщает о паузах перед повтором (429) — пробрасываем как heartbeat прогресса
        client.on_wait = progress.heartbeat
    except AttributeError:
        pass
    return run_agents(doc, client, options or ValidationOptions(), progress,
                      provider or getattr(client, "provider", ""), model or getattr(client, "model", ""), interactive,
                      ask_author)
