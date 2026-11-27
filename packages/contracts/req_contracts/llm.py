"""Конфигурация LLM-провайдеров и параметры прогона."""

from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, Field, SecretStr


class ProviderName(str, Enum):
    GEMINI = "gemini"
    OPENAI = "openai"
    ANTHROPIC = "anthropic"
    # Любой OpenAI-совместимый сервер: Ollama, vLLM, LM Studio. Фундамент для локальной модели.
    OPENAI_COMPATIBLE = "openai_compatible"


class ProviderConfig(BaseModel):
    """Всё, что нужно для вызова модели. В вебе собирается из настроек админки, в CLI — из флагов/окружения.

    Ядро не читает переменные окружения для этих параметров, если конфиг передан явно.
    """

    provider: ProviderName
    model: str
    api_key: SecretStr | None = Field(
        default=None, description="Для openai_compatible необязателен (локальный vLLM/Ollama без авторизации)"
    )
    base_url: str | None = Field(default=None, description="Обязателен для openai_compatible")
    temperature: float = 0.0
    max_output_tokens: int | None = Field(
        default=None, description="None — ядро выбирает с запасом (модели с рассуждениями тратят токены на reasoning)"
    )
    timeout_s: float = 180.0
    min_interval_s: float = Field(default=0.0, ge=0, description="Пауза между вызовами (бесплатные тарифы, 429)")
    max_attempts: int = Field(default=6, ge=1, description="Попыток на вызов при 429/5xx/сетевых ошибках")
    extra_body: dict[str, Any] | None = Field(
        default=None,
        description="Доп. поля тела запроса (OpenAI-совместимые серверы), напр. "
        '{"chat_template_kwargs": {"enable_thinking": false}} — отключить рассуждения у vLLM-модели',
    )
    extra_body_set_review: dict[str, Any] | None = Field(
        default=None,
        description="Переопределение extra_body для проверки набора (поиск противоречий), напр. включить рассуждения. "
        "None — используется extra_body",
    )


class EmbeddingProviderName(str, Enum):
    LOCAL = "local"  # sentence-transformers внутри сервиса embedder, работает офлайн
    GEMINI = "gemini"
    OPENAI = "openai"


class ValidationOptions(BaseModel):
    language: str = "ru"
    verify_pass: bool = Field(
        default=True, description="Верификатор: пытается опровергнуть каждый дефект и сливает дубли"
    )
    split_compound: bool = Field(default=True, description="Показывать атомарные подтребования составных")
    fill_checklist: bool = Field(default=True, description="Заполнять чек-лист «Ревью требований» из документа")
    ask_questions: bool = Field(default=True, description="Готовить уточняющие вопросы автору документа")
    max_questions: int = Field(default=15, ge=0, le=50, description="Не больше стольких вопросов")
    knowledge_snippets: list[str] = Field(
        default_factory=list, description="Фрагменты базы знаний (RAG), которые воркер подмешивает в промпт"
    )
    batch_size: int = Field(default=6, ge=1, description="Требований в одном запросе проверки")
    concurrency: int = Field(default=1, ge=1, description="Параллельных запросов к модели")
