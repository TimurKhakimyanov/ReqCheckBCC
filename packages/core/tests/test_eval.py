import importlib.util
import json
from pathlib import Path

from req_core import parse_document
from req_core.pipeline import run_pipeline
from req_core.testing import FakeLLM
from req_core.text import QuoteLocator

EVAL = Path(__file__).resolve().parents[1] / "eval"


def _recall_module():
    spec = importlib.util.spec_from_file_location("recall", EVAL / "recall.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_reference_quotes_exist_in_sample(sample_path):
    ref = json.loads((EVAL / "requirements_md_reference.json").read_text(encoding="utf-8"))
    loc = QuoteLocator(parse_document(sample_path).text)
    for d in ref["defects"]:
        for q in d["quotes"]:
            assert loc.locate(q) is not None, (d["id"], q)


def test_recall_on_rules_only_report(sample_path):
    ref = json.loads((EVAL / "requirements_md_reference.json").read_text(encoding="utf-8"))
    report = run_pipeline(parse_document(sample_path), FakeLLM())
    r, rows = _recall_module().recall(report, ref)
    hit = {rid for rid, _, h in rows if h}
    assert {"E-11", "E-18", "E-19"} <= hit  # то, что ловят детерминированные правила
    assert 0 < r < 1
