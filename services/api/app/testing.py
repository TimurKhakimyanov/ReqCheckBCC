"""Помощники для тестов api и worker: отдельная тестовая БД, фейковые сервисы, моки ядра."""

from __future__ import annotations

import ipaddress
import json
import os
import socket
from collections.abc import Callable, Iterator
from importlib import resources
from pathlib import Path

import psycopg
import redis
from qdrant_client import QdrantClient
from sqlalchemy.engine import make_url

from .embeddings import HashEmbedder
from .services import Services
from .storage import MemoryObjectStore

API_DIR = Path(__file__).resolve().parents[1]


def prepare_test_database(suffix: str) -> str:
    """Создаёт чистую БД <db>_<suffix>, применяет миграции и подменяет DATABASE_URL. Возвращает новый URL."""
    from alembic import command
    from alembic.config import Config

    base = make_url(os.environ["DATABASE_URL"])
    name = f"{base.database}_{suffix}"
    admin = base.set(drivername="postgresql").render_as_string(hide_password=False)
    with psycopg.connect(admin, autocommit=True) as conn:
        conn.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
        conn.execute(f'CREATE DATABASE "{name}"')
    url = base.set(database=name).render_as_string(hide_password=False)
    os.environ["DATABASE_URL"] = url
    from .config import get_settings
    from .db import get_engine, get_sessionmaker

    get_settings.cache_clear()
    get_engine.cache_clear()
    get_sessionmaker.cache_clear()
    cfg = Config(str(API_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(API_DIR / "migrations"))
    cfg.attributes["url"] = url
    command.upgrade(cfg, "head")
    return url


class RecordingServices(Services):
    """Сервисы для тестов: S3 в памяти, Qdrant в памяти, хеш-эмбеддинги, настоящий Redis; очередь — список."""

    def __init__(self, redis_url: str):
        super().__init__(store=MemoryObjectStore(), embedder=HashEmbedder(), qdrant=QdrantClient(":memory:"),
                         redis=redis.Redis.from_url(redis_url, decode_responses=True))
        self.enqueued: list[str] = []

    def enqueue_run(self, run_id: str) -> str:
        self.enqueued.append(run_id)
        return f"task-{run_id}"


def block_external_network() -> Callable[[], None]:
    """Запрещает тестам соединения с внешними адресами: разрешены только loopback и частные сети
    (postgres, redis в сети compose). Любая попытка сходить к провайдеру LLM падает с понятной ошибкой.
    Возвращает функцию, снимающую запрет."""
    original = socket.socket.connect
    original_ex = socket.socket.connect_ex

    def _check(address) -> None:
        if isinstance(address, tuple) and address:
            host = str(address[0])
            try:
                ip = ipaddress.ip_address(host.split("%")[0])
            except ValueError:
                raise RuntimeError(f"tests must not resolve external hosts: {host}") from None
            if not (ip.is_loopback or ip.is_private or ip.is_link_local):
                raise RuntimeError(f"tests must not reach external network: {host}")

    def connect(self, address):
        _check(address)
        return original(self, address)

    def connect_ex(self, address):
        _check(address)
        return original_ex(self, address)

    socket.socket.connect = connect  # type: ignore[method-assign]
    socket.socket.connect_ex = connect_ex  # type: ignore[method-assign]

    def restore() -> None:
        socket.socket.connect = original  # type: ignore[method-assign]
        socket.socket.connect_ex = original_ex  # type: ignore[method-assign]

    return restore


def sample_report_json() -> str:
    return resources.files("req_contracts.fixtures").joinpath("sample_report.json").read_text(encoding="utf-8")


def sample_report_dict() -> dict:
    return json.loads(sample_report_json())


def fake_answer_question(report, history, question, llm, knowledge_snippets=None) -> Iterator[str]:
    yield "По отчёту найдено "
    yield f"{len(report.findings)} дефектов. "
    yield f"Вопрос: {question}"


def fake_render_report(report, fmt) -> bytes:
    if fmt == "json":
        return report.model_dump_json().encode()
    return f"%{fmt.upper()} report for {report.passport.document_name}".encode()


# Последние конфиги, с которыми API звал ядро (проверка, что ключи/адреса/параметры берутся из БД)
CORE_CALLS: dict[str, object] = {}


def fake_list_models(cfg) -> list[str]:
    CORE_CALLS["list_models"] = cfg
    if cfg.api_key is not None and cfg.api_key.get_secret_value() == "bad-key":
        raise PermissionError("401 invalid api key")
    return ["model-b", "model-a"]


class _FakeLLM:
    def __init__(self, cfg):
        self.cfg = cfg

    def complete(self, system: str, user: str) -> str:
        CORE_CALLS["complete"] = self.cfg
        if self.cfg.api_key is not None and self.cfg.api_key.get_secret_value() == "bad-key":
            raise PermissionError("401 invalid api key")
        return "pong"


def fake_get_llm(cfg) -> _FakeLLM:
    return _FakeLLM(cfg)
