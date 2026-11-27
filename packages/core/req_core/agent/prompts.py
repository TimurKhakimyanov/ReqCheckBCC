"""Версионируемые системные промты. Методология агентов живёт в файлах prompts/*.md, а не в коде.

Формат файла:
    ---
    version: 3
    ---
    # SYSTEM
    ...текст с переменными {{name}}...
    # USER
    ...
"""
from __future__ import annotations

import re
from functools import lru_cache
from pathlib import Path

_DIR = Path(__file__).parent / "prompts"
_VAR = re.compile(r"\{\{(\w+)\}\}")


class Prompt:
    def __init__(self, name: str, version: str, system: str, user: str):
        self.name, self.version, self.system, self.user = name, version, system, user

    def render(self, **vars: object) -> tuple[str, str]:
        def sub(text: str) -> str:
            def repl(m: re.Match) -> str:
                key = m.group(1)
                if key not in vars:
                    raise KeyError(f"промт {self.name}: не передана переменная {key}")
                return str(vars[key])

            return _VAR.sub(repl, text)

        return sub(self.system), sub(self.user)


@lru_cache(maxsize=None)
def load(name: str) -> Prompt:
    raw = (_DIR / f"{name}.md").read_text(encoding="utf-8")
    version = "1"
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n", raw, re.S)
    if m:
        vm = re.search(r"version:\s*(\S+)", m.group(1))
        version = vm.group(1) if vm else "1"
        raw = raw[m.end():]
    parts = re.split(r"^# (SYSTEM|USER)\s*$", raw, flags=re.M)
    blocks = {parts[i]: parts[i + 1].strip() for i in range(1, len(parts) - 1, 2)}
    common = (_DIR / "_common.md").read_text(encoding="utf-8").strip()
    return Prompt(name, version, blocks.get("SYSTEM", "") + "\n\n" + common, blocks.get("USER", ""))


def versions() -> dict[str, str]:
    return {p.stem: load(p.stem).version for p in sorted(_DIR.glob("*.md")) if not p.stem.startswith("_")}
