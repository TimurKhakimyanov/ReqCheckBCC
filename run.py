"""Запуск одной командой, как в bbc-agent: python run.py <файл требований> <файл отчёта>

    python run.py examples/requirements.pdf reports/report.pdf
    python run.py doc.pdf reports/report.md --ask
    python run.py doc.pdf reports/report.md --answers reports/report.questions.json

Настройки модели — в .env рядом (как в bbc-agent: LLM_PROVIDER, OPENAI_BASE_URL, OPENAI_MODEL, LLM_CONCURRENCY …)
или флагами; полный список — python run.py --help. Зависимости: pip install -e packages/contracts -e packages/core
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
# пакеты репозитория без установки (зависимости — pydantic, openai, google-genai, pymupdf … — должны быть установлены)
for pkg in ("packages/contracts", "packages/core"):
    path = str(ROOT / pkg)
    if path not in sys.path:
        sys.path.insert(0, path)

from req_core.cli import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main())
