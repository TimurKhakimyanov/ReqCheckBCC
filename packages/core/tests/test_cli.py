import json

from req_contracts import Report

from req_core.cli import main


def test_cli_fake_provider_writes_reports(sample_path, tmp_path, capsys):
    out = tmp_path / "out" / "report.md"
    code = main([str(sample_path), str(out), "--provider", "fake", "--also", "json,docx,pdf"])
    assert code == 0
    md = out.read_text(encoding="utf-8")
    assert "## 1. Паспорт прогона" in md and "Итог" in md
    report = Report.model_validate(json.loads(out.with_suffix(".json").read_text(encoding="utf-8")))
    assert report.passport.provider == "fake"
    assert out.with_suffix(".docx").stat().st_size > 0
    assert out.with_suffix(".pdf").read_bytes()[:5] == b"%PDF-"
    err = capsys.readouterr().err
    assert "Отчёт:" in err and "%]" in err


def test_cli_format_flag_and_quiet(sample_path, tmp_path, capsys):
    out = tmp_path / "report.out"
    assert main([str(sample_path), str(out), "--provider", "fake", "--format", "json", "-q"]) == 0
    Report.model_validate_json(out.read_text(encoding="utf-8"))
    assert "%]" not in capsys.readouterr().err


def test_cli_errors(sample_path, tmp_path):
    assert main([str(tmp_path / "missing.md"), str(tmp_path / "r.md"), "--provider", "fake"]) == 2
    assert main([str(sample_path), str(tmp_path / "r.html"), "--provider", "fake"]) == 2
    assert main([str(sample_path), str(tmp_path / "r.md"), "--provider", "fake", "--also", "xml"]) == 2
    # нет ключа — понятная ошибка, а не трассировка
    assert main([str(sample_path), str(tmp_path / "r.md"), "--provider", "gemini", "--model", "x"]) == 1
