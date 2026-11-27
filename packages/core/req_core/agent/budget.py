"""Контроль контекста: агент не отправляет модели запрос, который не помещается в её окно.

Переполнение контекста опасно тем, что происходит молча: провайдер обрезает запрос или модель
«забывает» начало документа и начинает выдумывать. Поэтому:

  1) перед каждым вызовом размер запроса оценивается в токенах и сравнивается с лимитом;
  2) агенты заранее подстраивают объём: документ режется на части, вместо полного текста
     передаются окна вокруг нужных строк;
  3) запрос, который всё же не помещается, не отправляется (ContextOverflow), а работа
     возвращается планировщику меньшими порциями;
  4) фактическое число токенов каждого вызова калибрует оценку и попадает в отчёт.
"""
from __future__ import annotations

import threading
from dataclasses import dataclass, field


class ContextOverflow(RuntimeError):
    """Запрос не помещается в окно модели. Вызов не выполнялся."""


@dataclass
class Budget:
    window: int                     # окно модели, токенов (вход + выход)
    max_output: int                 # сколько токенов резервируем под ответ
    window_source: str = "по умолчанию"
    chars_per_token: float = 2.6    # осторожная стартовая оценка для русского текста; калибруется по факту
    peak_tokens: int = 0
    peak_call: str = ""
    prevented: int = 0              # сколько раз запрос был остановлен до отправки
    truncated: int = 0              # сколько раз модель оборвала ответ по лимиту
    warnings: list[str] = field(default_factory=list)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)
    _samples: int = 0

    # ------------------------------------------------------------------ лимиты
    @property
    def output_reserve(self) -> int:
        """Резерв под ответ: не больше половины окна, даже если LLM_MAX_TOKENS больше."""
        return min(self.max_output, self.window // 2)

    @property
    def input_limit(self) -> int:
        """Сколько токенов можно отдать на запрос (с запасом 8% на погрешность оценки)."""
        return int((self.window - self.output_reserve) * 0.92)

    @property
    def doc_limit(self) -> int:
        """Доля запроса под текст документа; остальное — инструкции, списки требований и замечаний."""
        return int(self.input_limit * 0.55)

    # ------------------------------------------------------------------ оценка
    def estimate(self, *texts: str) -> int:
        return int(sum(len(t) for t in texts) / self.chars_per_token) + 8

    def fits(self, *texts: str) -> bool:
        return self.estimate(*texts) <= self.input_limit

    def doc_fits(self, text: str) -> bool:
        return self.estimate(text) <= self.doc_limit

    def chars_for(self, tokens: int) -> int:
        return int(tokens * self.chars_per_token)

    def check(self, system: str, user: str, who: str) -> int:
        """Проверка перед вызовом. Возвращает оценку в токенах или бросает ContextOverflow."""
        est = self.estimate(system, user)
        if est > self.input_limit:
            with self._lock:
                self.prevented += 1
            raise ContextOverflow(
                f"{who}: запрос ~{est} токенов не помещается в лимит {self.input_limit} "
                f"(окно модели {self.window}, резерв под ответ {self.output_reserve})"
            )
        return est

    # ------------------------------------------------------------------ факт
    def observe(self, chars: int, tokens_in: int, who: str) -> None:
        """Калибровка по фактическому числу токенов и учёт пиковой загрузки окна."""
        if tokens_in <= 0 or chars <= 0:
            return
        with self._lock:
            observed = chars / tokens_in
            # берём более осторожное (меньшее) значение из наблюдавшихся, с запасом 5%
            if 1.0 <= observed <= 8.0:
                cand = observed * 0.95
                self.chars_per_token = cand if self._samples == 0 else min(self.chars_per_token, cand)
                self._samples += 1
            if tokens_in > self.peak_tokens:
                self.peak_tokens, self.peak_call = tokens_in, who
            if tokens_in > self.input_limit and not any("превысил" in w for w in self.warnings):
                self.warnings.append(f"фактический запрос ({tokens_in} токенов, {who}) превысил расчётный лимит {self.input_limit}")

    def note_truncated(self) -> None:
        with self._lock:
            self.truncated += 1

    @property
    def peak_pct(self) -> float:
        return round(100 * self.peak_tokens / self.window, 1) if self.window else 0.0

    def summary(self) -> dict:
        return {
            "window": self.window,
            "window_source": self.window_source,
            "output_reserve": self.output_reserve,
            "input_limit": self.input_limit,
            "doc_limit": self.doc_limit,
            "chars_per_token": round(self.chars_per_token, 2),
            "peak_tokens": self.peak_tokens,
            "peak_pct": self.peak_pct,
            "peak_call": self.peak_call,
            "prevented": self.prevented,
            "truncated": self.truncated,
            "warnings": list(self.warnings),
        }
