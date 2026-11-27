"""Версия агента для паспорта прогона (коммит или тег).

Порядок: `git describe` (запуск из клона) → переменная AGENT_VERSION → версия, вшитая при сборке образа:
сначала коммит из каталога .git (читается без git, см. `git_dir_version`), затем аргумент сборки AGENT_VERSION.
«dev» остаётся только когда узнать версию неоткуда (сборка из архива без .git и без AGENT_VERSION).
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from functools import lru_cache
from pathlib import Path

BAKED_VERSION_FILE = Path(os.environ.get("AGENT_VERSION_FILE", "/etc/reqcheck-agent-version"))
BAKED_GIT_VERSION_FILE = Path(os.environ.get("AGENT_GIT_VERSION_FILE", "/etc/reqcheck-git-version"))
_SHA = re.compile(r"^[0-9a-f]{40}$")


def git_dir_version(git_dir: str | Path) -> str:
    """Версия по содержимому каталога .git без вызова git: тег, указывающий на текущий коммит, иначе короткий хеш.

    Достаточно файлов HEAD, packed-refs и каталога refs — только они и попадают в контекст сборки образа
    (.dockerignore). Пустая строка — версию определить нельзя (нет .git, рабочая копия git worktree и т. п.).
    """
    root = Path(git_dir)
    try:
        head = (root / "HEAD").read_text(encoding="utf-8").strip()
    except OSError:
        return ""
    packed: dict[str, str] = {}
    try:
        for line in (root / "packed-refs").read_text(encoding="utf-8").splitlines():
            parts = line.split()
            if len(parts) == 2 and _SHA.match(parts[0]):
                packed[parts[1]] = parts[0]
    except OSError:
        pass

    def resolve(ref: str) -> str:
        try:
            return (root / ref).read_text(encoding="utf-8").strip()
        except OSError:
            return packed.get(ref, "")

    sha = resolve(head[5:].strip()) if head.startswith("ref:") else head
    if not _SHA.match(sha):
        return ""
    tags = {name[len("refs/tags/"):]: value for name, value in packed.items() if name.startswith("refs/tags/")}
    tag_dir = root / "refs" / "tags"
    if tag_dir.is_dir():
        for f in tag_dir.rglob("*"):
            if f.is_file():
                tags[f.relative_to(tag_dir).as_posix()] = f.read_text(encoding="utf-8").strip()
    for name in sorted(tags):
        if tags[name] == sha:  # лёгкий тег на текущем коммите
            return name
    return sha[:7]


def _read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


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
    for baked in (_read(BAKED_GIT_VERSION_FILE), _read(BAKED_VERSION_FILE)):
        if baked and baked != "dev":
            return baked
    return env or "dev"


if __name__ == "__main__":  # сборка образа: python -m req_core.version <каталог с содержимым .git>
    print(git_dir_version(sys.argv[1]) if len(sys.argv) > 1 else agent_version())
