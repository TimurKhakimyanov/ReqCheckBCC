"""Версия агента в паспорте отчёта: коммит или тег узнаются при сборке образа из каталога .git, без git."""

from __future__ import annotations

from req_core import version

SHA = "0123456789abcdef0123456789abcdef01234567"


def test_commit_from_a_loose_ref(tmp_path):
    (tmp_path / "refs" / "heads").mkdir(parents=True)
    (tmp_path / "HEAD").write_text("ref: refs/heads/main\n", encoding="utf-8")
    (tmp_path / "refs" / "heads" / "main").write_text(SHA + "\n", encoding="utf-8")
    assert version.git_dir_version(tmp_path) == "0123456"


def test_commit_from_packed_refs_and_detached_head(tmp_path):
    (tmp_path / "HEAD").write_text("ref: refs/heads/main\n", encoding="utf-8")
    (tmp_path / "packed-refs").write_text(f"# pack-refs with: peeled fully-peeled sorted\n{SHA} refs/heads/main\n",
                                          encoding="utf-8")
    assert version.git_dir_version(tmp_path) == "0123456"
    (tmp_path / "HEAD").write_text(SHA + "\n", encoding="utf-8")
    assert version.git_dir_version(tmp_path) == "0123456"


def test_tag_on_the_current_commit_wins(tmp_path):
    (tmp_path / "refs" / "tags").mkdir(parents=True)
    (tmp_path / "HEAD").write_text(SHA + "\n", encoding="utf-8")
    (tmp_path / "refs" / "tags" / "v1.0").write_text(SHA + "\n", encoding="utf-8")
    assert version.git_dir_version(tmp_path) == "v1.0"


def test_unknown_when_there_is_no_git_dir(tmp_path):
    assert version.git_dir_version(tmp_path) == ""
    (tmp_path / ".git").write_text("gitdir: /somewhere/else\n", encoding="utf-8")  # рабочая копия git worktree
    assert version.git_dir_version(tmp_path) == ""


def test_baked_commit_is_used_when_git_and_env_are_absent(tmp_path, monkeypatch):
    baked = tmp_path / "git-version"
    baked.write_text("abc1234\n", encoding="utf-8")
    monkeypatch.setattr(version, "BAKED_GIT_VERSION_FILE", baked)
    monkeypatch.setattr(version, "BAKED_VERSION_FILE", tmp_path / "missing")
    monkeypatch.setattr(version.subprocess, "run", lambda *a, **k: (_ for _ in ()).throw(OSError("нет git")))
    monkeypatch.setenv("AGENT_VERSION", "dev")
    version.agent_version.cache_clear()
    try:
        assert version.agent_version() == "abc1234"
        monkeypatch.setenv("AGENT_VERSION", "v2.0")  # явная версия важнее вшитой
        version.agent_version.cache_clear()
        assert version.agent_version() == "v2.0"
    finally:
        version.agent_version.cache_clear()
