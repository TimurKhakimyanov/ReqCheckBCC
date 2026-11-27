"""Конфигурация LLM-провайдеров и параметры прогона."""

from __future__ import annotations

from enum import Enum

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


class EmbeddingProviderName(str, Enum):
    LOCAL = "local"  # sentence-transformers внутри сервиса embedder, работает офлайн
    GEMINI = "gemini"
    OPENAI = "openai"


class ValidationOptions(BaseModel):
    language: str = "ru"
    verify_pass: bool = Field(default=False, description="Второй проход «критик» перепроверяет дефекты")
    split_compound: bool = Field(default=True, description="Показывать атомарные подтребования составных")
    fill_checklist: bool = Field(default=True, description="Заполнять чек-лист «Ревью требований» из документа")
    knowledge_snippets: list[str] = Field(
        default_factory=list, description="Фрагменты базы знаний (RAG), которые воркер подмешивает в промпт"
    )
    batch_size: int = Field(default=6, ge=1, description="Требований в одном запросе проверки")
    concurrency: int = Field(default=1, ge=1, description="Параллельных запросов к модели")
