"""Параметры прогона агентов (вместо .env bbc-agent: ядро читает только ValidationOptions)."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class AgentConfig:
    concurrency: int = 1  # параллельных воркеров (запросов к модели)
    batch_size: int = 5  # требований на один вызов инспектора
