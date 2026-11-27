from __future__ import annotations

from pathlib import Path

import pytest
import req_contracts
from req_contracts import Report

REPO = Path(__file__).resolve().parents[3]
SAMPLE = REPO / "samples" / "requirements.md"
FIXTURE_REPORT = Path(req_contracts.__file__).parent / "fixtures" / "sample_report.json"


@pytest.fixture(autouse=True)
def _no_real_keys(monkeypatch):
    for name in ("GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY",
                 "OPENAI_COMPATIBLE_API_KEY", "LLM_PROVIDER", "LLM_MODEL", "LLM_MIN_INTERVAL_S"):
        monkeypatch.delenv(name, raising=False)


@pytest.fixture
def sample_path() -> Path:
    assert SAMPLE.is_file(), SAMPLE
    return SAMPLE


@pytest.fixture
def sample_report() -> Report:
    return Report.model_validate_json(FIXTURE_REPORT.read_text(encoding="utf-8"))
