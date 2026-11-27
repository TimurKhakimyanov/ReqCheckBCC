import json
from pathlib import Path

from req_contracts import CRITERIA, REQUIREMENT_CRITERIA, SET_CRITERIA, Criterion, Report

FIXTURES = Path(__file__).resolve().parents[1] / "req_contracts" / "fixtures"


def test_every_criterion_has_info():
    assert set(CRITERIA) == set(Criterion)
    assert set(REQUIREMENT_CRITERIA) | set(SET_CRITERIA) == set(Criterion)


def test_sample_report_is_valid():
    report = Report.model_validate_json((FIXTURES / "sample_report.json").read_text(encoding="utf-8"))
    assert report.summary.findings_total == len(report.findings)
    assert report.summary.requirements_total == len(report.requirements)


def test_sample_quotes_match_offsets():
    report = Report.model_validate_json((FIXTURES / "sample_report.json").read_text(encoding="utf-8"))
    text = report.document.text
    locations = [r.location for r in report.requirements] + [l for f in report.findings for l in f.locations]
    for loc in locations:
        assert loc.verified
        assert text[loc.char_start : loc.char_end] == loc.quote


def test_finding_ids_referenced_exist():
    report = Report.model_validate_json((FIXTURES / "sample_report.json").read_text(encoding="utf-8"))
    ids = {f.id for f in report.findings}
    refs = [fid for a in report.requirement_assessments for c in a.checks for fid in c.finding_ids]
    refs += [fid for c in report.set_assessment.checks for fid in c.finding_ids]
    assert set(refs) <= ids


def test_schema_file_is_current():
    on_disk = json.loads((FIXTURES / "report.schema.json").read_text(encoding="utf-8"))
    assert on_disk == Report.model_json_schema()
