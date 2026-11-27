"""Оркестратор прогона (методика bbc-agent): документ на входе — отчёт ReqCheck (Report) на выходе.

Этапы: чтение → правила (подсказки) → нарезчик (два прохода) → планировщик и воркеры (инспектор по
матрице «требование × критерий», шесть рецензентов набора, раунды до полного покрытия) → верификатор
(перепроверка, слияние дублей) → вопросы автору и чек-лист → ответы автора (если переданы) → итог.
Агенты пишут в общий граф; отчёт собирается обходом графа.
"""

from __future__ import annotations

import contextvars
import logging
import re
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any, Callable

from req_contracts import (
    REQUIREMENT_CRITERIA,
    SET_CRITERIA,
    CheckVerdict,
    ChecklistAnswer,
    ChecklistItem,
    ClarifyingQuestion,
    Conclusion,
    Criterion,
    CriterionCheck,
    Decision,
    DefectType,
    Finding,
    FindingScope,
    FindingSource,
    FixItem,
    Grounding,
    ParsedDocument,
    QualityStats,
    QuestionPriority,
    QuestionResolution,
    Report,
    Requirement,
    RequirementAssessment,
    RequirementKind,
    RequirementRewrite,
    RunPassport,
    RunStage,
    SetAssessment,
    Severity,
    SkippedFragment,
    SourceLocation,
    Summary,
    Usage,
    ValidationOptions,
)

from ..text import QuoteLocator, SectionIndex, page_for, plural, shorten
from . import guard, prompts
from .agents import clarifier, extractor, finalizer, planner, verifier
from .agents.common import Ctx
from .config import AgentConfig
from .criteria import INDIVIDUAL, SET
from .graph import Graph, pick_prefixes
from .ingest import Document, from_parsed
from .llm import AgentLLM, Stop
from .rules import Hint, run_rules
from .textmatch import QuoteIndex

log = logging.getLogger("req_core.agent")

I_TO_CRITERION = {
    "I1": Criterion.NECESSARY, "I2": Criterion.IMPLEMENTATION_FREE, "I3": Criterion.UNAMBIGUOUS,
    "I4": Criterion.COMPLETE, "I5": Criterion.SINGULAR, "I6": Criterion.FEASIBLE, "I7": Criterion.VERIFIABLE,
    "I8": Criterion.CORRECT, "I9": Criterion.CONFORMING,
}
S_TO_CRITERION = {
    "S1": Criterion.SET_COMPLETE, "S2": Criterion.SET_CONSISTENT, "S3": Criterion.SET_FEASIBLE,
    "S4": Criterion.SET_COMPREHENSIBLE, "S5": Criterion.SET_VALIDATABLE, "S6": Criterion.SET_RANKED,
    "S7": Criterion.SET_MODIFIABLE, "S8": Criterion.SET_TRACEABLE,
}
CODE_TO_CRITERION = {**I_TO_CRITERION, **S_TO_CRITERION}
CRITERION_TO_CODE = {v: k for k, v in CODE_TO_CRITERION.items()}
KIND = {
    "functional": RequirementKind.FUNCTIONAL, "non_functional": RequirementKind.NON_FUNCTIONAL,
    "data": RequirementKind.DATA, "interface": RequirementKind.API, "integration": RequirementKind.INTEGRATION,
    "ui": RequirementKind.UI, "acceptance": RequirementKind.ACCEPTANCE,
}
ANSWER = {"Да": ChecklistAnswer.YES, "Нет": ChecklistAnswer.NO, "Частично": ChecklistAnswer.PARTIAL,
          "Не требуется": ChecklistAnswer.NOT_REQUIRED}
DECISION = {"нельзя": Decision.BLOCKED, "можно с ограничениями": Decision.LIMITED, "можно": Decision.READY}
SEV_RANK = {"critical": 0, "major": 1, "minor": 2}

# Этапы → стадия прогресса и доля общего прогресса (начало, конец)
STAGES = {
    "ingest": (RunStage.PARSING, 0.02, 0.04),
    "rules": (RunStage.RULE_CHECKS, 0.04, 0.06),
    "extract": (RunStage.SEGMENTING, 0.06, 0.24),
    "check": (RunStage.CHECKING_REQUIREMENTS, 0.24, 0.76),
    "verify": (RunStage.VERIFYING, 0.76, 0.88),
    "clarify": (RunStage.VERIFYING, 0.88, 0.94),
    "verdict": (RunStage.VERIFYING, 0.94, 0.97),
    "report": (RunStage.VERIFYING, 0.97, 0.99),
}
STAGE_TITLES = {
    "ingest": "Чтение документа", "rules": "Автоматические правила (без LLM)",
    "extract": "Нарезчик: выделение требований", "check": "Планировщик и воркеры: проверка требований и набора",
    "verify": "Верификатор: перепроверка замечаний и слияние дублей",
    "clarify": "Аналитик уточнений: вопросы автору и чек-лист ревью", "verdict": "Итоговое заключение",
    "report": "Сборка отчёта",
}

FOREIGN_SCRIPT = re.compile(r"[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]+")
TITLE_LIMIT = 110


def split_title(title: str, explanation: str) -> tuple[str, str]:
    """Короткий заголовок дефекта. Если модель написала в заголовок объяснение — заголовок обрезается по слову,
    а полный текст переносится в объяснение (ничего не теряется)."""
    title = " ".join((title or explanation).split())
    explanation = explanation or title
    if len(title) <= TITLE_LIMIT:
        return title, explanation
    short = shorten(title, TITLE_LIMIT)
    if title not in explanation:
        explanation = f"{title} {explanation}".strip() if explanation != title else title
    return short, explanation


def _clean(s: str | None) -> str | None:
    if not s:
        return s
    return re.sub(r"[ \t]{2,}", " ", FOREIGN_SCRIPT.sub(" ", s)).strip()


def strip_foreign_script(report: Report) -> Report:
    """Убирает иероглифы, которые модель вставляет в русский текст (цитаты не трогаем — они из документа)."""
    for f in report.findings:
        f.title, f.explanation, f.suggestion = _clean(f.title), _clean(f.explanation), _clean(f.suggestion)
    for r in report.requirements:
        r.summary = _clean(r.summary)
    for a in report.requirement_assessments:
        for c in a.checks:
            c.comment = _clean(c.comment)
    for c in report.set_assessment.checks:
        c.comment = _clean(c.comment)
    for item in report.checklist:
        item.comment = _clean(item.comment)
    for q in report.questions:
        q.question, q.why = _clean(q.question), _clean(q.why)
        q.options = [_clean(o) for o in q.options]
    c = report.conclusion
    c.rationale, c.development, c.testing = _clean(c.rationale), _clean(c.development), _clean(c.testing)
    c.top_fixes = [_clean(x) for x in c.top_fixes]
    c.strengths = [_clean(x) for x in c.strengths]
    for fx in c.fixes:
        fx.action, fx.why = _clean(fx.action), _clean(fx.why)
    return report


# ---------------------------------------------------------------------------- подсказки старых правил ReqCheck


def _reqcheck_hints(doc: Document) -> list[Hint]:
    """Детерминированные проверки ReqCheck (незаполненные разделы и поля шаблона, версия документа) — как
    подсказки агентам: модель подтверждает их замечанием или отбрасывает, верификатор перепроверяет."""
    from ..rules import rule_findings

    try:
        drafts = rule_findings(doc.text, SectionIndex(doc.text), [])
    except Exception as e:  # noqa: BLE001 — подсказки необязательны
        log.warning("Правила ReqCheck не отработали: %s", e)
        return []
    out = []
    for d in drafts:
        if not d.spans:
            continue
        no = doc.line_at(d.spans[0][0])
        ln = doc.line(no)
        out.append(Hint(f"reqcheck:{d.criterion.value}", no, (ln.text.strip() if ln else "")[:200],
                        f"{d.title}. {d.explanation}"))
    return out


# ---------------------------------------------------------------------------- прогон


# Ответы автора по ходу прогона (веб-аналог --ask): получает вопросы, возвращает {Q-01: ответ}; пустой dict — пропустить
AskAuthor = Callable[[list[ClarifyingQuestion]], dict[str, str]]


class Run:
    def __init__(self, pd: ParsedDocument, client: Any, options: ValidationOptions, progress: Any,
                 provider: str, model: str, interactive: bool = False, ask: AskAuthor | None = None):
        self.pd = pd
        self.interactive = interactive  # --ask: вопросы автору в консоли, как в bbc-agent
        self.ask = ask  # то же для веба: вопросы уходят на экран прогона, ответы приходят обратно
        self.client = client
        self.options = options
        self.progress = progress
        self.provider = provider
        self.model = model
        self.doc = from_parsed(pd)
        self.locator = QuoteLocator(pd.text)
        graph = Graph()
        graph.prefix = pick_prefixes("\n".join(ln.text for ln in self.doc.lines))
        self.graph = graph
        self.llm = AgentLLM(client, knowledge=options.knowledge_snippets, progress=progress, on_activity=graph.log)
        self.stage_key = "ingest"
        self.ctx = Ctx(
            cfg=AgentConfig(concurrency=max(1, options.concurrency), batch_size=max(1, options.batch_size)),
            llm=self.llm, graph=graph, doc=self.doc, index=QuoteIndex(self.doc), say=self.say, tick=self.tick,
        )
        self.warnings: list[str] = []

    # --- ход работы
    def _emit(self, frac: float, message: str, current: int | None = None, total: int | None = None,
              stage: RunStage | None = None) -> None:
        st, a, b = STAGES[self.stage_key]
        self.progress(stage or st, a + (b - a) * max(0.0, min(1.0, frac)), message, current, total)

    def say(self, msg: str) -> None:
        msg = msg.strip()
        if msg:
            log.info("%s", msg)

    def tick(self, done: int, total: int, title: str) -> None:
        stage = RunStage.CHECKING_SET if title.startswith("Ревью набора") else None
        self._emit(done / max(total, 1), title, done, total, stage)

    def stage(self, key: str) -> None:
        self.stage_key = key
        self.graph.stage = key
        self.graph.log({"kind": "stage_start", "title": STAGE_TITLES[key]})
        self._emit(0.0, STAGE_TITLES[key])

    def _safe(self, name: str, fn, *args) -> None:
        """Необязательный шаг: сбой не роняет прогон, но попадает в предупреждения отчёта."""
        try:
            fn(*args)
        except Exception as e:  # noqa: BLE001
            self.graph.log({"kind": f"{name}_failed", "error": f"{type(e).__name__}: {e}"[:300]})
            self.warnings.append(f"{name}: {shorten(re.sub(r'https?://\S+', '<url>', str(e)), 160)}")
            log.warning("Шаг «%s» не выполнен: %s", name, e)

    def run(self) -> Report:
        t0 = time.monotonic()
        try:
            return self._run(t0)
        except Stop as s:
            raise s.cause from None

    def _run(self, t0: float) -> Report:
        ctx, graph, doc, opt = self.ctx, self.graph, self.doc, self.options

        self.stage("ingest")
        graph.add("document", "DOC", "open", title=doc.title, file=doc.name, fmt=doc.fmt, sha256=doc.sha256,
                  lines=len(doc.lines))
        for c in INDIVIDUAL + SET:
            graph.add("criterion", c.code, "active", name=c.name, ref=c.ref)

        self.stage("rules")
        seen: set[tuple[int, str]] = set()
        for h in run_rules(doc) + _reqcheck_hints(doc):
            if (h.line, h.note) in seen:
                continue
            seen.add((h.line, h.note))
            graph.add("hint", graph.new_id("H"), "active", rule=h.rule, line=h.line, text=h.text, note=h.note)

        self.stage("extract")
        ctx.meta["rule_candidates"] = self._rule_candidates()
        extractor.run(ctx)

        self.stage("check")
        if graph.of("requirement") or doc.text.strip():
            planner.run(ctx)

        self.stage("verify")
        verifier.run(ctx, check=opt.verify_pass)
        if ctx.meta.get("dedup_failed"):
            self.warnings.append("слияние дублей: модель не ответила, слиты только явные повторы — "
                                 "в отчёте могут остаться похожие замечания")

        self.stage("clarify")
        jobs = []
        if opt.ask_questions and opt.max_questions > 0:
            jobs.append(("clarifier", clarifier.ask, (ctx, opt.max_questions)))
        if opt.fill_checklist:
            jobs.append(("checklist", finalizer.checklist, (ctx,)))
        if len(jobs) > 1:  # два независимых вызова — параллельно, как в bbc-agent (при любой параллельности воркеров)
            with ThreadPoolExecutor(max_workers=2) as pool:
                futs = [pool.submit(contextvars.copy_context().run, self._safe, n, f, *a) for n, f, a in jobs]
                for fut in futs:
                    fut.result()
        else:
            for n, f, a in jobs:
                self._safe(n, f, *a)
        answers = {k.strip(): v.strip() for k, v in opt.answers.items() if k.strip() and v and v.strip()}
        if not answers and self.interactive:  # как run.py --ask в bbc-agent: спросить в консоли и учесть в этом же прогоне
            answers = clarifier.interactive(ctx, opt.max_questions)
        if not answers and self.ask is not None and opt.ask_author:  # то же из веба: ждём ответы с экрана прогона
            answers = self._ask_author()
        if answers:
            self._safe("ответы автора", clarifier.resolve, ctx, answers)

        self.stage("verdict")
        self._safe("итог", finalizer.verdict, ctx)

        self.stage("report")
        report = self._report(t0)
        if not FOREIGN_SCRIPT.search(doc.text):
            report = strip_foreign_script(report)
        self.progress(RunStage.DONE, 1.0,
                      f"Готово: требований {len(report.requirements)}, дефектов {len(report.findings)}")
        return report

    def _ask_author(self) -> dict[str, str]:
        """Вопросы в отчётном виде (как в разделе «Вопросы») → внешний обработчик → ответы только на эти вопросы."""
        fids = {n.payload["fid"] for n in self.graph.of("finding", "confirmed") if n.payload.get("fid")}
        order = {QuestionPriority.BLOCKER: 0, QuestionPriority.IMPORTANT: 1, QuestionPriority.MINOR: 2}
        qs = sorted(self._questions(fids), key=lambda q: (order.get(q.priority, 1), q.id))[: self.options.max_questions]
        if not qs:
            return {}
        self._emit(1.0, f"Ждём ответов автора: вопросов {len(qs)}")
        raw = self.ask(qs) or {}
        ids = {q.id for q in qs}
        answers = {k.strip(): v.strip() for k, v in raw.items() if k.strip() in ids and v and v.strip()}
        self.graph.log({"kind": "author_answers", "asked": len(qs), "answered": len(answers)})
        self._emit(1.0, f"Ответов автора: {len(answers)} из {len(qs)}" if answers else "Вопросы пропущены — продолжаем без ответов")
        return answers

    # --- сборка отчёта из графа
    def location(self, a: int, b: int, quote: str | None = None, score: float = 1.0) -> SourceLocation:
        doc = self.doc
        cs, ce = doc.char_span(a, b)
        if quote and score >= 0.8:  # уточняем место цитаты внутри строк
            m = self.locator.locate(quote, hint=cs)
            if m and cs - 2 <= m.start and m.end <= ce + 2 and m.end > m.start:
                cs, ce = m.start, m.end
        ln = doc.line(a)
        return SourceLocation(
            section=(ln.section if ln and ln.section else "Документ"), quote=self.pd.text[cs:ce],
            char_start=cs, char_end=ce, page=page_for(cs, self.pd.page_offsets), verified=score >= 0.8,
            line_start=a, line_end=b,
        )

    def _report(self, t0: float) -> Report:
        g, doc, ctx = self.graph, self.doc, self.ctx
        reqs = sorted(g.of("requirement"), key=lambda n: n.payload["line_start"])
        confirmed = sorted(g.of("finding", "confirmed"), key=lambda n: n.payload.get("fid", n.id))

        requirements = []
        for r in reqs:
            p = r.payload
            requirements.append(Requirement(
                id=r.id, source_id=p.get("doc_id") or None, kind=KIND.get(p.get("type"), RequirementKind.OTHER),
                summary=p.get("summary") or shorten(p.get("text", ""), 160),
                location=self.location(p["line_start"], p["line_end"]),
            ))

        findings: list[Finding] = []
        for n in confirmed:
            p = n.payload
            title, explanation = split_title(p.get("title", ""), p.get("problem", ""))
            locs = [self.location(e["line_start"], e["line_end"], e.get("quote"), float(e.get("score", 1.0)))
                    for e in p.get("evidence", [])[:4]]
            if not locs:
                continue
            grounding = (p.get("grounding") or {}).get("level")
            try:
                dtype = DefectType(p.get("defect_type"))
            except ValueError:
                dtype = None
            found_by = list(dict.fromkeys([p.get("source", "")] + [a.get("source", "") for a in p.get("also", [])]))
            findings.append(Finding(
                id=p["fid"], scope=FindingScope.REQUIREMENT if p.get("level") == "req" else FindingScope.SET,
                requirement_ids=[x for x in p.get("req_ids", []) if g.get(x)],
                criterion=CODE_TO_CRITERION.get(p["criterion"], Criterion.SET_COMPLETE),
                severity=Severity(p.get("severity", "major")), title=title, explanation=explanation, locations=locs,
                suggestion=p.get("recommendation") or None, source=FindingSource.LLM, defect_type=dtype,
                grounding=Grounding(grounding) if grounding in ("exact", "fuzzy", "line") else None,
                found_by=[x for x in found_by if x], verifier_note=(p.get("verify") or {}).get("reason") or None,
                resolved_by=p.get("resolved_by"),
            ))
        fids = {f.id for f in findings}

        # проверка каждого требования: вердикты инспектора, приведённые верификатором к подтверждённым замечаниям
        cells: dict[tuple[str, str], list[str]] = {}
        for n in confirmed:
            p = n.payload
            if p.get("level") == "req":
                for rid in p.get("req_ids", []):
                    cells.setdefault((rid, p["criterion"]), []).append(p["fid"])
            for rid, code in p.get("covers", []):
                cells.setdefault((rid, code), []).append(p["fid"])
        titles = {f.id: f.title for f in findings}
        assessments = []
        for r in reqs:
            verdicts = r.payload.get("verdicts", {})
            checks = []
            for c in REQUIREMENT_CRITERIA:
                code = CRITERION_TO_CODE.get(c)
                if code is None:
                    checks.append(CriterionCheck(criterion=c, verdict=CheckVerdict.NOT_APPLICABLE,
                                                 comment="Оценивается на уровне набора (прослеживаемость, S8)"))
                    continue
                ids = [i for i in dict.fromkeys(cells.get((r.id, code), [])) if i in fids]
                v = verdicts.get(code)
                if ids:
                    checks.append(CriterionCheck(criterion=c, verdict=CheckVerdict.FAIL,
                                                 comment="; ".join(titles[i] for i in ids), finding_ids=ids))
                elif v == "na":
                    checks.append(CriterionCheck(criterion=c, verdict=CheckVerdict.NOT_APPLICABLE))
                elif v in ("ok", "violation"):
                    checks.append(CriterionCheck(criterion=c, verdict=CheckVerdict.PASS))
                else:
                    checks.append(CriterionCheck(criterion=c, verdict=CheckVerdict.NOT_APPLICABLE,
                                                 comment="Не оценено: модель не дала вердикт по критерию"))
            assessments.append(RequirementAssessment(requirement_id=r.id, checks=checks))

        # проверка набора: замечания + мнения рецензентов
        opinions = ctx.meta.get("set_verdicts", {})
        set_checks = []
        for c in SET_CRITERIA:
            code = CRITERION_TO_CODE[c]
            fs = [f for f in findings if f.criterion == c]
            ops = sorted(opinions.get(code, []), key=lambda o: o["by"])
            by = list(dict.fromkeys(o["by"] for o in ops))
            if fs:
                worst = min(fs, key=lambda f: SEV_RANK[f.severity.value])
                set_checks.append(CriterionCheck(
                    criterion=c, verdict=CheckVerdict.FAIL, finding_ids=[f.id for f in fs], assessed_by=by,
                    comment=(f"{plural(len(fs), 'замечание', 'замечания', 'замечаний')}, наиболее серьёзное — "
                             f"{worst.id}: {worst.title}" if len(fs) > 1 else f"{worst.id}: {worst.title}")))
            elif ops:
                why = next((o["rationale"] for o in ops if o["status"] == "ok" and o["rationale"]), "") or \
                    "Заявленные рецензентом нарушения не подтверждены верификатором"
                set_checks.append(CriterionCheck(criterion=c, verdict=CheckVerdict.PASS, comment=why, assessed_by=by))
            else:
                set_checks.append(CriterionCheck(criterion=c, verdict=CheckVerdict.NOT_APPLICABLE,
                                                 comment="Рецензент не дал оценки"))

        checklist = self._checklist(findings)
        questions = self._questions(fids)

        by_sev = {s: sum(1 for f in findings if f.severity == s) for s in Severity}
        summary = Summary(requirements_total=len(requirements), findings_total=len(findings), by_severity=by_sev,
                          critical_finding_ids=[f.id for f in findings if f.severity == Severity.CRITICAL])
        conclusion = self._conclusion(findings, len(requirements))

        usage = Usage.model_validate(getattr(self.client, "usage", Usage()).model_dump())
        usage.duration_s = round(time.monotonic() - t0, 1)
        return Report(
            passport=RunPassport(
                document_name=self.pd.name, document_sha256=self.pd.sha256,
                run_at=datetime.now(timezone.utc).replace(microsecond=0),
                provider=self.provider, model=self.model, agent_version=_agent_version(),
            ),
            document=self.pd, requirements=requirements, requirement_assessments=assessments,
            set_assessment=SetAssessment(checks=set_checks), findings=findings, checklist=checklist,
            questions=questions, summary=summary, conclusion=conclusion, usage=usage,
            document_title=doc.title or None, skipped=self._skipped(), quality=self._quality(len(findings)),
        )

    def _rule_candidates(self) -> list[dict]:
        """Кандидаты в требования от правил ReqCheck (segment_hints) в построчном виде для нарезчика."""
        from ..rules import segment_hints

        kind = {RequirementKind.API: "interface", RequirementKind.OTHER: "functional"}
        try:
            hints = segment_hints(self.pd.text, SectionIndex(self.pd.text))
        except Exception as e:  # noqa: BLE001
            log.warning("Кандидаты правил не получены: %s", e)
            return []
        out = []
        for h in hints:
            a, b = self.doc.line_at(h.start), self.doc.line_at(max(h.start, h.end - 1))
            out.append({"line_start": a, "line_end": b, "quote": self.pd.text[h.start:h.end],
                        "doc_id": h.source_id or "", "summary": h.summary,
                        "type": kind.get(h.kind, h.kind.value)})
        return out

    def _skipped(self) -> list[SkippedFragment]:
        out = []
        for k in self.ctx.meta.get("skipped", []):
            try:
                out.append(SkippedFragment(location=self.location(k["line_start"], k["line_end"]),
                                           reason=k.get("reason") or "не требование"))
            except (KeyError, IndexError):
                continue
        return out

    def _checklist(self, findings: list[Finding]) -> list[ChecklistItem]:
        rows = self.ctx.meta.get("checklist") or []
        pref = re.escape(self.graph.prefix["finding"])
        valid = {f.id for f in findings}
        out = []
        for r in rows:
            comment = r.get("comment") or ""
            refs = [x for x in dict.fromkeys(re.findall(rf"(?<![\w-]){pref}-\d{{3}}", comment)) if x in valid]
            ans = ANSWER.get(r.get("answer", ""))
            if ans is None:
                out.append(_checklist_fallback(r.get("item", ""), findings))
                continue
            out.append(ChecklistItem(question=r.get("item", ""), answer=ans, comment=comment or "—", finding_ids=refs))
        return out

    def _questions(self, fids: set[str]) -> list[ClarifyingQuestion]:
        prio = {p.value: p for p in QuestionPriority}
        out = []
        for q in sorted(self.graph.of("question"), key=lambda n: n.id):
            p = q.payload
            res = p.get("resolution")
            resolution = None
            if isinstance(res, dict):
                resolution = QuestionResolution(
                    rewrites=[RequirementRewrite(requirement_id=w["req_id"], new_text=w["new_text"])
                              for w in res.get("rewrites", [])],
                    closes_findings=[x for x in res.get("closes_findings", []) if x in fids],
                    note=res.get("note", ""),
                )
            out.append(ClarifyingQuestion(
                id=q.id, question=p.get("question", ""), why=p.get("why") or "Без ответа требование трактуется по-разному.",
                addressee=p.get("addressee") or "Аналитик", priority=prio.get(p.get("priority"), QuestionPriority.IMPORTANT),
                finding_ids=[x for x in p.get("finding_ids", []) if x in fids], options=p.get("options", [])[:4],
                requirement_ids=p.get("req_ids", []), answer=p.get("answer"), resolution=resolution,
            ))
        return out

    def _conclusion(self, findings: list[Finding], n_req: int) -> Conclusion:
        v = self.ctx.meta.get("verdict") or {}
        decision = DECISION.get(v.get("decision", ""))
        n_crit = sum(1 for f in findings if f.severity == Severity.CRITICAL)
        n_major = sum(1 for f in findings if f.severity == Severity.MAJOR)
        guard_note = v.get("guard", "")
        if decision is None:  # итог не получен от модели — решение по правилу bbc-agent
            decision = Decision.BLOCKED if n_crit else Decision.LIMITED if n_major else Decision.READY
        cov = self.ctx.meta.get("coverage") or {}
        if n_req == 0:
            decision, guard_note = Decision.BLOCKED, "в документе не выделено ни одного требования"
        elif decision == Decision.READY and (cov.get("uncovered_reqs") or cov.get("reviews_failed")):
            decision = Decision.LIMITED
            guard_note = "решение ужесточено правилом: не все требования и рецензии получили ответ модели"
        rationale = (v.get("rationale") or "").strip()
        if not rationale:
            if n_req == 0:
                rationale = "Агент не выделил в документе ни одного требования — документ нельзя передавать в работу."
            elif decision == Decision.READY:
                rationale = "Критичных и существенных дефектов не найдено; замечания можно исправить параллельно с работой."
            else:
                crit_ids = ", ".join(f.id for f in findings if f.severity == Severity.CRITICAL) or "—"
                rationale = (f"Найдено критичных дефектов: {n_crit} ({crit_ids}), существенных: {n_major}. "
                             "До их исправления реализация и тестирование потребуют домысливания требований.")
        fixes = []
        for fx in v.get("top_fixes", []):
            ids = [i for i in fx.get("finding_ids", []) if any(f.id == i for f in findings)]
            if fx.get("action"):
                fixes.append(FixItem(action=fx["action"], why=fx.get("why", ""), finding_ids=ids))
        top = [(f"{', '.join(fx.finding_ids)}: " if fx.finding_ids else "") + fx.action for fx in fixes]
        notes = list(self.warnings)
        if cov.get("uncovered_reqs"):
            notes.append(f"не проверены по всем критериям требования: {', '.join(cov['uncovered_reqs'][:8])}")
        if cov.get("reviews_failed"):
            notes.append(f"не ответили рецензенты набора: {', '.join(cov['reviews_failed'])}")
        dedup_notes = [n for n in notes if n.startswith("слияние дублей")]
        notes = [n for n in notes if n not in dedup_notes]
        if notes:
            rationale += (f" Внимание: отчёт может быть неполным ({'; '.join(n.split(':')[0] if len(n) > 120 else n for n in notes[:5])}).")
        if dedup_notes:
            rationale += f" Внимание: {dedup_notes[0]}."
        return Conclusion(
            ready_for_development=decision != Decision.BLOCKED, ready_for_testing=decision == Decision.READY,
            rationale=rationale, top_fixes=top, decision=decision, development=v.get("development", ""),
            testing=v.get("testing", ""), fixes=fixes, strengths=v.get("strengths", []), guard_note=guard_note,
        )

    def _quality(self, confirmed: int) -> QualityStats:
        ctx = self.ctx
        gs = guard.summary(ctx)
        ver = ctx.meta.get("verification") or {}
        cov = ctx.meta.get("coverage") or {}
        ext = ctx.meta.get("extraction") or {}
        ev = gs.get("evidence_levels", {})
        b = self.llm.budget
        return QualityStats(
            candidates=gs.get("candidates", 0), rejected_by_code=gs.get("rejected_by_code", 0),
            rejected_by_verifier=gs.get("rejected_by_verifier", 0), merged=gs.get("merged", 0), confirmed=confirmed,
            unverified=ver.get("unverified", 0), evidence_exact=ev.get("exact", 0), evidence_fuzzy=ev.get("fuzzy", 0),
            evidence_line=ev.get("line", 0), inline_quotes_unverified=gs.get("inline_quotes_unverified", 0),
            removed_refs=gs.get("removed_refs", 0), matrix_cells_total=cov.get("cells_total", 0),
            matrix_cells_filled=cov.get("cells_filled", 0), rounds=cov.get("rounds", 0),
            uncovered_requirements=cov.get("uncovered_reqs", []), reviews_failed=cov.get("reviews_failed", []),
            extracted_first_pass=ext.get("first_pass", 0), extracted_by_coverage=max(0, ext.get("added_by_coverage", 0)),
            context_window=b.window, context_peak_pct=b.peak_pct,
            doc_parts=(ctx.meta.get("context_mode") or {}).get("review_parts", 1),
            prompt_versions=prompts.versions(), warnings=list(self.warnings) + list(b.warnings),
        )


def _checklist_fallback(q: str, findings: list[Finding]) -> ChecklistItem:
    """Пункт чек-листа без ответа модели: по связанным критериям найденных дефектов (как в ReqCheck)."""
    ql = q.lower()
    rules = [
        ("противореч", {Criterion.SET_CONSISTENT, Criterion.CORRECT}),
        ("протестир", {Criterion.VERIFIABLE, Criterion.SET_VALIDATABLE}),
        ("верси", {Criterion.SET_MODIFIABLE}),
        ("структурирован", {Criterion.CONFORMING, Criterion.SET_COMPREHENSIBLE}),
        ("покрывает", {Criterion.SET_COMPLETE, Criterion.COMPLETE}),
    ]
    for key, crits in rules:
        if key in ql:
            rel = [f.id for f in findings if f.criterion in crits]
            return ChecklistItem(question=q, answer=ChecklistAnswer.NO if rel else ChecklistAnswer.YES,
                                 comment="Есть связанные дефекты." if rel else "Связанных дефектов не найдено.",
                                 finding_ids=rel[:10])
    return ChecklistItem(question=q, answer=ChecklistAnswer.NO,
                         comment="Агент не смог оценить пункт автоматически — требуется ручная проверка.")


def _agent_version() -> str:
    from ..version import agent_version

    return agent_version()


def run_agents(pd: ParsedDocument, client: Any, options: ValidationOptions, progress: Any, provider: str,
               model: str, interactive: bool = False, ask: AskAuthor | None = None) -> Report:
    return Run(pd, client, options, progress, provider, model, interactive, ask).run()
