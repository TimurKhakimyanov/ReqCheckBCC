"""Версия агента для паспорта прогона: git describe → AGENT_VERSION → версия, вшитая при сборке образа."""

from __future__ import annotations

import os
import subprocess
from functools import lru_cache
from pathlib import Path

BAKED_VERSION_FILE = Path(os.environ.get("AGENT_VERSION_FILE", "/etc/reqcheck-agent-version"))


@lru_cache(maxsize=1)
def agent_version() -> str:
    try:
        out = subprocess.run(
            ["git", "describe", "--always", "--dirty"], cwd=Path(__file__).resolve().parent,
            capture_output=True, text=True, timeout=5,
        )
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        pass
    env = os.environ.get("AGENT_VERSION", "").strip()
    if env and env != "dev":
        return env
    try:
        baked = BAKED_VERSION_FILE.read_text(encoding="utf-8").strip()
        if baked:
            return baked
    except OSError:
        pass
    return env or "dev"
