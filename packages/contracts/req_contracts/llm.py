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
    provider: ProviderName
    model: str
    api_key: SecretStr | None = None
    base_url: str | None = Field(default=None, description="Обязателен для openai_compatible")
    temperature: float = 0.0
    max_output_tokens: int | None = None
    timeout_s: float = 180.0


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
