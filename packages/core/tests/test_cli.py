import json

import pytest
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
    assert main([str(sample_path), str(out), "--provider", "fake", "--format", "json", "-q", "--no-pdf"]) == 0
    Report.model_validate_json(out.read_text(encoding="utf-8"))
    assert "%]" not in capsys.readouterr().err
    assert not out.with_suffix(".pdf").exists()


def test_cli_always_writes_pdf_next_to_report(sample_path, tmp_path):
    out = tmp_path / "report.md"
    assert main([str(sample_path), str(out), "--provider", "fake", "-q"]) == 0
    assert out.read_text(encoding="utf-8").startswith("# Отчёт")
    assert out.with_suffix(".pdf").read_bytes()[:5] == b"%PDF-"


def test_cli_output_without_extension_is_pdf(sample_path, tmp_path):
    out = tmp_path / "report"
    assert main([str(sample_path), str(out), "--provider", "fake", "-q"]) == 0
    assert out.with_suffix(".pdf").read_bytes()[:5] == b"%PDF-"
    assert not out.exists()


def test_cli_errors(sample_path, tmp_path):
    assert main([str(tmp_path / "missing.md"), str(tmp_path / "r.md"), "--provider", "fake"]) == 2
    assert main([str(sample_path), str(tmp_path / "r.html"), "--provider", "fake"]) == 2
    assert main([str(sample_path), str(tmp_path / "r.md"), "--provider", "fake", "--also", "xml"]) == 2
    # нет ключа — понятная ошибка, а не трассировка
    assert main([str(sample_path), str(tmp_path / "r.md"), "--provider", "gemini", "--model", "x"]) == 1


def test_cli_reads_bbc_agent_env(tmp_path, monkeypatch):
    """Тот же .env, что у bbc-agent: OpenAI-совместимый сервер, параллельность, лимиты, параметры запроса."""
    from req_core.cli import _provider_config, build_parser, load_env_file

    for k in ("OPENAI_BASE_URL", "OPENAI_MODEL", "LLM_CONCURRENCY", "AGENT_BATCH_SIZE", "LLM_TIMEOUT",
              "LLM_MAX_RETRIES", "LLM_EXTRA_BODY", "LLM_EXTRA_BODY_REVIEWER", "LLM_MAX_TOKENS"):
        monkeypatch.setenv(k, "-")  # monkeypatch запомнит исходное состояние и уберёт то, что загрузит файл
        monkeypatch.delenv(k)
    env = tmp_path / ".env"
    env.write_text(
        "# как в bbc-agent\nLLM_PROVIDER=openai\nOPENAI_BASE_URL=http://llm.example.local:8000/v1\nOPENAI_MODEL=mimo-v2.6-flash\n"
        "LLM_CONCURRENCY=8\nAGENT_BATCH_SIZE=5\nLLM_TIMEOUT=600\nLLM_MAX_RETRIES=5\nLLM_MAX_TOKENS=32000\n"
        'LLM_EXTRA_BODY={"chat_template_kwargs":{"enable_thinking":false}}\n'
        "LLM_EXTRA_BODY_REVIEWER='{\"chat_template_kwargs\":{\"enable_thinking\":true}}'\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("LLM_PROVIDER", "openai")  # уже заданное окружение важнее файла — как load_dotenv(override=False)
    assert load_env_file(env) == 9
    cfg = _provider_config(build_parser().parse_args(["in.md", "out.pdf"]))
    assert cfg.provider.value == "openai_compatible" and cfg.base_url == "http://llm.example.local:8000/v1"
    assert (cfg.model, cfg.timeout_s, cfg.max_attempts, cfg.max_output_tokens) == ("mimo-v2.6-flash", 600, 6, 32000)
    assert cfg.extra_body == {"chat_template_kwargs": {"enable_thinking": False}}
    assert cfg.extra_body_set_review == {"chat_template_kwargs": {"enable_thinking": True}}
    # флаг важнее переменной
    cfg = _provider_config(build_parser().parse_args(["in.md", "out.pdf", "--model", "other", "--timeout", "30"]))
    assert (cfg.model, cfg.timeout_s) == ("other", 30)


def test_cli_concurrency_and_batch_from_env(sample_path, tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("LLM_CONCURRENCY", "8")
    monkeypatch.setenv("AGENT_BATCH_SIZE", "5")
    assert main([str(sample_path), str(tmp_path / "r.md"), "--provider", "fake", "--no-pdf"]) == 0
    assert "параллельно: 8; пакет: 5" in capsys.readouterr().err


def test_run_py_at_repo_root(sample_path, tmp_path):
    """python run.py <документ> <отчёт> — как в bbc-agent."""
    import subprocess
    import sys
    from pathlib import Path

    root = Path(__file__).resolve().parents[3]
    run = root / "run.py"
    if not run.exists():  # в образе тестов ядра корень репозитория может быть не скопирован
        pytest.skip("run.py нет в образе")
    out = tmp_path / "report.md"
    r = subprocess.run([sys.executable, str(run), str(sample_path), str(out), "--provider", "fake", "--no-pdf", "-q"],
                       capture_output=True, text=True, encoding="utf-8", cwd=tmp_path)
    assert r.returncode == 0, r.stderr
    assert out.read_text(encoding="utf-8").startswith("# Отчёт")
    help_ = subprocess.run([sys.executable, str(run), "--help"], capture_output=True, text=True, encoding="utf-8")
    assert "--ask" in help_.stdout and "--answers" in help_.stdout and "--no-cache" in help_.stdout
