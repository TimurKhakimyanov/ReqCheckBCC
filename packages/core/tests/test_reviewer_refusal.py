"""Отказ модели (Anthropic stop_reason=refusal) у рецензентов набора: промпт без триггера, без повторов, с предупреждением."""

from types import SimpleNamespace as NS

import pytest
from pydantic import SecretStr
from req_contracts import ProviderConfig, ProviderName

from req_core import llm as L
from req_core import parse_document, render_report
from req_core.agent import prompts
from req_core.agent.agents import planner
from req_core.agent.agents.reviewers import PERSPECTIVES
from req_core.pipeline import run_pipeline
from req_core.testing import FakeLLM

# Формулировки, которые модель читает как просьбу выдать внутренние рассуждения, — на них claude-opus-5-5 отказывала
# всем ролям рецензентов набора.
TRIGGERS = ("рабочие заметки", "черновик", "сначала подумай", "сначала рассуди", "сначала заполни поле analysis")

CONSISTENCY = "зона — бизнес-правила"  # признак роли «Контролёр логики правил» в системном промпте


def test_reviewer_prompt_has_no_refusal_trigger():
    p = prompts.load("reviewer")
    assert int(p.version) >= 5
    for persp in PERSPECTIVES:  # промпт целиком, как его видит каждая роль
        system, _ = p.render(persona=persp["persona"], focus=persp["focus"], criteria="", document="",
                             requirements="", hints="")
        low = system.lower()
        assert not [t for t in TRIGGERS if t in low], persp["key"]
        assert "протокол проверки" in low


def test_anthropic_refusal_is_distinct_and_not_retried():
    cfg = ProviderConfig(provider=ProviderName.ANTHROPIC, model="claude-opus-5-5", api_key=SecretStr("k"),
                         max_attempts=3)
    c = L.AnthropicLLM(cfg)
    calls = []

    class _Ctx:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def get_final_message(self):
            return NS(content=[], stop_reason="refusal", usage=NS(input_tokens=10, output_tokens=0))

    def stream(**kw):
        calls.append(kw)
        return _Ctx()

    c.client = NS(messages=NS(stream=stream))
    with pytest.raises(L.LLMRefusal, match="refusal"):
        c.complete_reply("s", "u")
    assert isinstance(L.LLMRefusal("x"), L.LLMError)  # старые обработчики LLMError его по-прежнему ловят
    assert not L.is_retryable(L.LLMRefusal("x")) and len(calls) == 1


def _reviewer(exc):
    calls: list[str] = []

    def reviewer(system, user):
        calls.append(system)
        if CONSISTENCY in system:
            raise exc
        return {"analysis": "Протокол проверки.", "verdicts": {}, "findings": []}

    return reviewer, calls


def test_reviewer_refusal_is_not_retried_across_rounds_and_is_reported(sample_path):
    reviewer, calls = _reviewer(L.LLMRefusal("Anthropic: модель отказалась отвечать (stop_reason=refusal)"))
    # без ответов инспектора матрица не заполняется — планировщик проходит все раунды
    report = run_pipeline(parse_document(sample_path), FakeLLM({"reviewer": reviewer}))

    assert report.quality.rounds == planner.MAX_ROUNDS
    assert sum(CONSISTENCY in s for s in calls) == 1  # отказ не повторяется в следующих раундах
    assert len(calls) == len(PERSPECTIVES)
    q = report.quality
    assert q.reviews_failed == ["consistency"]
    refusals = [w for w in q.warnings if "модель отказалась отвечать" in w]
    assert refusals == ["проверка набора (роль «Контролёр логики правил») не выполнена: модель отказалась отвечать"]
    r = report.conclusion.rationale
    assert "модель отказалась проверять набор (1 из 6 ролей)" in r
    assert "не ответили рецензенты набора" not in r
    md = render_report(report, "md").decode("utf-8")
    assert "Отказ модели" in md and "«Контролёр логики правил»" in md


def test_other_reviewer_errors_are_still_retried(sample_path):
    reviewer, calls = _reviewer(L.LLMError("сбой провайдера"))
    report = run_pipeline(parse_document(sample_path), FakeLLM({"reviewer": reviewer}))

    assert sum(CONSISTENCY in s for s in calls) == planner.MAX_ROUNDS
    assert report.quality.reviews_failed == ["consistency"]
    assert not [w for w in report.quality.warnings if "отказалась" in w]
    assert "не ответили рецензенты набора: consistency" in report.conclusion.rationale
