"""Конвейер проверки: нарезка → правила → проверка требований → проверка набора → критик →
проверка цитат кодом → чек-лист → сводка и итог."""

from __future__ import annotations

import contextlib
import logging
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any

from req_contracts import (
    REQUIREMENT_CRITERIA,
    SET_CRITERIA,
    CheckVerdict,
    ChecklistAnswer,
    ChecklistItem,
    Conclusion,
    Criterion,
    CriterionCheck,
    Finding,
    FindingScope,
    FindingSource,
    ParsedDocument,
    ProgressCallback,
    ProgressEvent,
    Report,
    Requirement,
    RequirementAssessment,
    RunPassport,
    RunStage,
    SetAssessment,
    Severity,
    SourceLocation,
    Summary,
    Usage,
    ValidationOptions,
)

from . import prompts
from .llm import LLMConfigError, LLMError, _status_of
from .rules import (
    FindingDraft,
    ReqDraft,
    extract_checklist,
    overlap,
    rule_findings,
    segment_hints,
)
from .schemas import (
    ChecklistResult,
    ConclusionResult,
    CriticResult,
    Issue,
    RequirementBatchResult,
    SegmentationResult,
    SetConsistencyResult,
    SetReviewResult,
)
from .text import QuoteLocator, SectionIndex, clean_inline, page_for, shorten

log = logging.getLogger("req_core.pipeline")

SEVERITY_RANK = {Severity.CRITICAL: 0, Severity.MAJOR: 1, Severity.MINOR: 2}


class Settings:
    """Параметры прогона — только из ValidationOptions (окружение ядро не читает)."""

    context_chars = 150_000  # текст документа в промпте
    segment_chunk_chars = 40_000  # фрагмент документа для нарезки
    critic_batch = 30

    def __init__(self, options: ValidationOptions) -> None:
        self.batch_size = max(1, options.batch_size)
        self.concurrency = max(1, options.concurrency)


class Progress:
    """Обёртка над on_progress. Исключение из callback (отмена, таймаут воркера) НЕ глотается:
    оно запоминается в `aborted` и прерывает конвейер, даже если возникло внутри LLM-вызова."""

    def __init__(self, cb: ProgressCallback | None):
        self.cb = cb
        self.last = 0.0
        self.stage = RunStage.PARSING
        self.aborted: BaseException | None = None
        self._lock = threading.Lock()

    def __call__(self, stage: RunStage, progress: float, message: str = "", current: int | None = None,
                 total: int | None = None) -> None:
        if self.aborted is not None:
            raise self.aborted
        with self._lock:
            self.last = max(self.last, min(1.0, progress))
            self.stage = stage
            event = ProgressEvent(stage=stage, progress=self.last, message=message, current=current, total=total)
        if self.cb:
            try:
                self.cb(event)
            except BaseException as e:
                self.aborted = e
                raise

    def heartbeat(self, message: str) -> None:
        """Событие без изменения стадии — во время ожидания лимитов провайдера (даёт сработать отмене)."""
        self(self.stage, self.last, message)


TITLE_LIMIT = 110


def split_title(title: str, explanation: str) -> tuple[str, str]:
    """Короткий заголовок дефекта. Если модель написала в заголовок объяснение — первая фраза идёт
    в заголовок, а полный текст переносится в объяснение (ничего не теряется)."""
    title = " ".join((title or explanation).split())
    explanation = explanation or title
    if len(title) <= TITLE_LIMIT:
        return title, explanation
    first = re.split(r"(?<=[.!?:;])\s+|\s+[—–]\s+", title, maxsplit=1)[0].rstrip(".:;")
    short = first if 12 <= len(first) <= TITLE_LIMIT else shorten(first, TITLE_LIMIT)
    if title not in explanation:
        explanation = f"{title} {explanation}".strip() if explanation != title else title
    return short, explanation


def _fatal(e: BaseException) -> bool:
    """Ошибки, при которых продолжать бессмысленно (ключ, модель, доступ)."""
    return isinstance(e, LLMConfigError) or _status_of(e) in (401, 403, 404)


class Pipeline:
    def __init__(self, doc: ParsedDocument, client: Any, options: ValidationOptions,
                 progress: Progress, provider: str, model: str):
        self.doc = doc
        self.text = doc.text
        self.client = client
        self.options = options
        self.progress = progress
        self.provider = provider
        self.model = model
        self.s = Settings(options)
        self.sections = SectionIndex(self.text)
        self.locator = QuoteLocator(self.text)
        self.system = prompts.system_prompt(options.knowledge_snippets)
        self.warnings: list[str] = []
        self.dropped_unverified = 0
        self.llm_ok = 0
        try:  # клиент LLM сообщает о паузах перед повтором (429) — пробрасываем как heartbeat прогресса
            client.on_wait = progress.heartbeat
        except AttributeError:
            pass

    # ------------------------------------------------------------ LLM-вызов с учётом ошибок

    def ask(self, user: str, schema: type, what: str) -> Any | None:
        try:
            res = self.client.complete_json(self.system, user, schema)
            self.llm_ok += 1
            return res
        except Exception as e:  # noqa: BLE001
            if self.progress.aborted is not None:  # отмена/таймаут из on_progress — прерываем прогон
                raise
            # первая же неудача на нарезке (сеть, квота) — дальше всё упадёт так же; ошибку схемы терпим
            if _fatal(e) or (self.llm_ok == 0 and what == "нарезка" and not isinstance(e, LLMError)):
                raise
            log.warning("Шаг «%s» не выполнен моделью: %s", what, e)
            # адреса серверов в отчёт не попадают
            self.warnings.append(f"{what}: {shorten(re.sub(r'https?://\S+', '<url>', str(e)), 160)}")
            return None

    # ------------------------------------------------------------ нарезка

    def _chunks(self) -> list[tuple[int, int]]:
        limit = self.s.segment_chunk_chars
        n = len(self.text)
        if n <= limit:
            return [(0, n)]
        bounds = sorted({0, n, *[h.offset for h in self.sections.headings]})
        chunks, start = [], 0
        for b in bounds[1:]:
            if b - start > limit and b != bounds[1]:
                prev = max(x for x in bounds if x < b)
                if prev > start:
                    chunks.append((start, prev))
                    start = prev
            while b - start > limit * 1.5:  # очень длинный раздел без заголовков
                cut = self.text.rfind("\n\n", start, start + limit)
                cut = cut if cut > start else start + limit
                chunks.append((start, cut))
                start = cut
        chunks.append((start, n))
        return [c for c in chunks if c[1] > c[0]]

    def segment(self) -> list[ReqDraft]:
        self.progress(RunStage.SEGMENTING, 0.08, "Выделение требований")
        hints = segment_hints(self.text, self.sections)
        llm_drafts: list[ReqDraft] = []
        chunks = self._chunks()
        for ci, (cs, ce) in enumerate(chunks, 1):
            cand = [
                (f"[{h.source_id}] " if h.source_id else "") + shorten(self.text[h.start:h.end], 180)
                for h in hints if cs <= h.start < ce
            ]
            res = self.ask(prompts.segment_prompt(self.text[cs:ce], cand, self.s.context_chars),
                           SegmentationResult, "нарезка")
            self.progress(RunStage.SEGMENTING, 0.08 + 0.12 * ci / len(chunks), "Выделение требований", ci, len(chunks))
            if not res:
                continue
            for r in res.requirements:
                m = self.locator.locate(r.quote, hint=cs)
                if not m:
                    log.info("Требование модели не найдено в тексте: %s", shorten(r.quote, 80))
                    continue
                d = ReqDraft(m.start, m.end, r.kind, shorten(r.summary or clean_inline(r.quote), 160),
                             r.source_id.strip() or None, origin="llm")
                for p in r.parts:
                    pm = self.locator.locate(p.quote, hint=m.start)
                    if pm and pm.start >= m.start - 5 and pm.end <= m.end + 5:
                        d.parts.append(ReqDraft(pm.start, pm.end, r.kind,
                                                shorten(p.summary or clean_inline(p.quote), 160), origin="llm"))
                llm_drafts.append(d)

        # дубли модели
        merged: list[ReqDraft] = []
        for d in sorted(llm_drafts, key=lambda x: (x.start, -x.length)):
            if any(overlap((d.start, d.end), (o.start, o.end)) >= 0.8 * min(d.length, o.length) for o in merged):
                continue
            merged.append(d)
        # подсказки правил, которые модель пропустила
        spans = [(d.start, d.end) for d in merged] + [(p.start, p.end) for d in merged for p in d.parts]
        for h in hints:
            cov = sum(overlap((h.start, h.end), s) for s in spans)
            if cov >= 0.5 * h.length:
                if h.source_id:
                    for d in merged:
                        if not d.source_id and overlap((h.start, h.end), (d.start, d.end)) >= 0.5 * h.length:
                            d.source_id = h.source_id
                            break
                continue
            merged.append(h)
        merged.sort(key=lambda d: d.start)

        for i, d in enumerate(merged, 1):
            d.id = f"R-{i:03d}"
            parts = sorted(d.parts, key=lambda p: p.start)
            d.parts = parts if self.options.split_compound and len(parts) >= 2 else []
            for j, p in enumerate(d.parts, 1):
                p.id = f"{d.id}.{j}"
                p.parent_id = d.id
                p.kind = d.kind
        return merged

    # ------------------------------------------------------------ местоположения

    def location(self, start: int, end: int) -> SourceLocation:
        return SourceLocation(
            section=self.sections.path(start), quote=self.text[start:end], char_start=start, char_end=end,
            page=page_for(start, self.doc.page_offsets), verified=True,
        )

    def req_block(self, d: ReqDraft) -> str:
        head = f"### {d.id} · в документе: {d.source_id or '—'} · тип: {d.kind.value} · раздел: {self.sections.path(d.start)}"
        body = self.text[d.start:d.end].strip()
        parts = ""
        if d.parts:
            parts = "\nАтомарные части:\n" + "\n".join(
                f"- {p.id}: «{shorten(self.text[p.start:p.end], 300)}»" for p in d.parts)
        return f"{head}\n{body}{parts}"

    def reqs_list(self, drafts: list[ReqDraft]) -> str:
        out = []
        for d in drafts:
            out.append(f"- {d.id} ({d.source_id or 'без номера'}, {d.kind.value}): {d.summary}")
            out += [f"  - {p.id}: {p.summary}" for p in d.parts]
        return "\n".join(out)

    @staticmethod
    def known_block(found: list[FindingDraft], title: str = "Уже найдено (не повторяй эти дефекты)") -> str:
        if not found:
            return ""
        lines = [f"- {', '.join(f.requirement_ids) or 'набор'}: {f.title}" for f in found[:80]]
        return f"\n{title}:\n" + "\n".join(lines) + "\n"

    # ------------------------------------------------------------ проверки LLM

    def issues_to_drafts(self, issues: list[Issue], known_ids: set[str], default_scope: FindingScope) -> list[FindingDraft]:
        out = []
        for it in issues:
            rids = [r for r in dict.fromkeys(x.strip() for x in it.requirement_ids) if r in known_ids]
            scope = default_scope
            if it.criterion in SET_CRITERIA or not rids:
                scope = FindingScope.SET
            if not it.title.strip() and not it.explanation.strip():
                continue
            title, explanation = split_title(it.title.strip(), it.explanation.strip())
            out.append(FindingDraft(
                scope=scope, criterion=it.criterion, severity=it.severity,
                title=title, explanation=explanation,
                requirement_ids=rids, suggestion=it.suggestion.strip() or None, source=FindingSource.LLM,
                unverified_quotes=[q for q in it.quotes if q and q.strip()],
            ))
        return out

    def check_requirements(self, drafts: list[ReqDraft], known: list[FindingDraft], ids: set[str]
                           ) -> tuple[list[FindingDraft], dict[str, set[Criterion]]]:
        batches = [drafts[i:i + self.s.batch_size] for i in range(0, len(drafts), self.s.batch_size)]
        doc = prompts.doc_block(self.text, self.s.context_chars)
        crit = prompts.requirement_criteria_block()
        done = 0
        total = len(drafts)  # прогресс — по требованиям (current/total), хотя бы одно событие на каждое

        def report_batch(batch: list[ReqDraft]) -> None:
            nonlocal done
            for d in batch:
                done += 1
                self.progress(RunStage.CHECKING_REQUIREMENTS, 0.3 + 0.4 * done / total,
                              f"Проверено требование {d.id}", done, total)

        def run(batch: list[ReqDraft]) -> RequirementBatchResult | None:
            self.progress(RunStage.CHECKING_REQUIREMENTS, 0.3 + 0.4 * done / total,
                          f"Проверка требований {batch[0].id}–{batch[-1].id}", done, total)
            bids = {d.id for d in batch} | {p.id for d in batch for p in d.parts}
            kn = [f for f in known if set(f.requirement_ids) & bids]
            user = prompts.REQ_TASK.format(
                criteria=crit, known=self.known_block(kn, "Уже найдено правилами (не повторяй)"),
                reqs="\n\n".join(self.req_block(d) for d in batch), doc=doc,
            )
            return self.ask(user, RequirementBatchResult, "проверка требований " + ", ".join(d.id for d in batch))

        results: list[RequirementBatchResult | None] = []
        if self.s.concurrency > 1 and len(batches) > 1:
            ex = ThreadPoolExecutor(self.s.concurrency)
            try:
                for b, res in zip(batches, ex.map(run, batches)):
                    results.append(res)
                    report_batch(b)
            finally:  # при отмене не ждём оставшиеся пакеты
                ex.shutdown(wait=self.progress.aborted is None, cancel_futures=True)
        else:
            for b in batches:
                results.append(run(b))
                report_batch(b)
        issues: list[FindingDraft] = []
        na: dict[str, set[Criterion]] = {}
        for res in results:
            if not res:
                continue
            issues += self.issues_to_drafts(res.issues, ids, FindingScope.REQUIREMENT)
            for item in res.not_applicable:
                if item.requirement_id in ids:
                    na.setdefault(item.requirement_id, set()).update(
                        c for c in item.not_applicable if c in REQUIREMENT_CRITERIA)
        return issues, na

    def _set_review_body(self):
        """На проверке набора — cfg.extra_body_set_review (напр. включить рассуждения для поиска противоречий)."""
        body = getattr(getattr(self.client, "cfg", None), "extra_body_set_review", None)
        use = getattr(self.client, "use_extra_body", None)
        return use(body) if use and body is not None else contextlib.nullcontext()

    def check_set(self, drafts: list[ReqDraft], known: list[FindingDraft], ids: set[str]
                  ) -> tuple[list[FindingDraft], dict[Criterion, Any]]:
        doc = prompts.doc_block(self.text, self.s.context_chars)
        reqs = self.reqs_list(drafts)
        with self._set_review_body():
            self.progress(RunStage.CHECKING_SET, 0.72, "Проверка согласованности набора")
            cons = self.ask(prompts.SET_CONSISTENCY_TASK.format(
                known=self.known_block([f for f in known if f.scope == FindingScope.SET]), reqs=reqs, doc=doc),
                SetConsistencyResult, "проверка согласованности набора")
            self.progress(RunStage.CHECKING_SET, 0.8, "Проверка полноты набора")
            rev = self.ask(prompts.SET_REVIEW_TASK.format(
                criteria=prompts.set_criteria_block(), known=self.known_block(known), reqs=reqs, doc=doc),
                SetReviewResult, "проверка полноты набора")
        out: list[FindingDraft] = []
        checks: dict[Criterion, Any] = {}
        if cons:
            out += self.issues_to_drafts(cons.issues, ids, FindingScope.SET)
        if rev:
            out += self.issues_to_drafts(rev.issues, ids, FindingScope.SET)
            for c in rev.checks:
                if c.criterion in SET_CRITERIA:
                    checks[c.criterion] = c
        return out, checks

    # ------------------------------------------------------------ цитаты

    def resolve_quotes(self, findings: list[FindingDraft], req_by_id: dict[str, ReqDraft]) -> list[FindingDraft]:
        self.progress(RunStage.VERIFYING, 0.86, "Проверка цитат")
        kept = []
        for f in findings:
            if f.source == FindingSource.RULE and f.spans:
                kept.append(f)
                continue
            hint = req_by_id[f.requirement_ids[0]].start if f.requirement_ids else None
            spans, unverified = list(f.spans), []
            for q in f.unverified_quotes:
                m = self.locator.locate(q, hint=hint)
                if m and (m.start, m.end) not in spans:
                    spans.append((m.start, m.end))
                elif not m:
                    unverified.append(q)
            if not spans:
                if f.requirement_ids:
                    r = req_by_id[f.requirement_ids[0]]
                    spans = [(r.start, r.end)]
                    f.explanation += " (Цитата модели не найдена в тексте дословно; указано место требования.)"
                else:
                    self.dropped_unverified += 1
                    log.info("Дефект отброшен — цитаты не подтверждены: %s", f.title)
                    continue
            f.spans = spans[:4]
            f.unverified_quotes = unverified[:1]
            kept.append(f)
        return kept

    @staticmethod
    def dedupe(findings: list[FindingDraft]) -> list[FindingDraft]:
        out: list[FindingDraft] = []
        for f in findings:
            dup = None
            for o in out:
                if o.criterion != f.criterion:
                    continue
                if f.requirement_ids and o.requirement_ids and not set(f.requirement_ids) & set(o.requirement_ids):
                    continue
                if any(overlap(a, b) >= 0.5 * max(1, min(a[1] - a[0], b[1] - b[0])) for a in f.spans for b in o.spans):
                    dup = o
                    break
            if dup is None:
                out.append(f)
                continue
            # оставляем более критичный; при равенстве — первый (LLM раньше правил)
            if SEVERITY_RANK[f.severity] < SEVERITY_RANK[dup.severity]:
                f.requirement_ids = list(dict.fromkeys(f.requirement_ids + dup.requirement_ids))
                out[out.index(dup)] = f
            else:
                dup.requirement_ids = list(dict.fromkeys(dup.requirement_ids + f.requirement_ids))
        return out

    # ------------------------------------------------------------ критик

    def critic(self, findings: list[FindingDraft]) -> list[FindingDraft]:
        self.progress(RunStage.VERIFYING, 0.88, "Перепроверка дефектов (критик)")
        for i, f in enumerate(findings, 1):
            f.id = f"tmp-{i}"
        by_id = {f.id: f for f in findings}
        doc = prompts.doc_block(self.text, self.s.context_chars)
        drop: set[str] = set()
        for i in range(0, len(findings), self.s.critic_batch):
            batch = findings[i:i + self.s.critic_batch]
            block = "\n\n".join(
                f"{f.id} [{f.criterion.value}, {f.severity.value}, {', '.join(f.requirement_ids) or 'набор'}] {f.title}\n"
                f"{f.explanation}\nЦитаты: " + " / ".join(f"«{shorten(self.text[s:e], 250)}»" for s, e in f.spans)
                for f in batch
            )
            res = self.ask(prompts.CRITIC_TASK.format(findings=block, doc=doc), CriticResult, "критик")
            if not res:
                continue
            for v in res.verdicts:
                f = by_id.get(v.finding_id.strip())
                if not f:
                    continue
                if not v.keep and f.source == FindingSource.LLM:
                    drop.add(f.id)
                sev = v.severity.strip().lower()
                if sev in {s.value for s in Severity}:
                    f.severity = Severity(sev)
        return [f for f in findings if f.id not in drop]

    # ------------------------------------------------------------ сборка отчёта

    def run(self) -> Report:
        t0 = time.monotonic()
        drafts = self.segment()
        flat: list[ReqDraft] = []
        for d in drafts:
            flat.append(d)
            flat.extend(d.parts)
        req_by_id = {d.id: d for d in flat}
        ids = set(req_by_id)

        self.progress(RunStage.RULE_CHECKS, 0.25, "Детерминированные проверки")
        rules = rule_findings(self.text, self.sections, drafts)
        for d in drafts:
            if d.parts:
                rules.append(FindingDraft(
                    scope=FindingScope.REQUIREMENT, criterion=Criterion.SINGULAR, severity=Severity.MINOR,
                    title=f"Составное требование: {len(d.parts)} независимых положения",
                    explanation="Требование объединяет несколько независимо проверяемых положений ("
                    + "; ".join(f"{p.id} — {p.summary}" for p in d.parts)
                    + "); их сложнее трассировать к тестам и менять по отдельности.",
                    spans=[(d.start, d.end)], requirement_ids=[d.id], source=FindingSource.LLM,
                    suggestion="Разделить на отдельные требования со своими идентификаторами.",
                ))

        req_issues, na = self.check_requirements(drafts, rules, ids) if drafts else ([], {})
        set_issues, set_checks = self.check_set(drafts, rules + req_issues, ids)

        findings = self.resolve_quotes(req_issues + set_issues + rules, req_by_id)
        findings = self.dedupe(findings)
        if self.options.verify_pass and findings:
            findings = self.critic(findings)

        order = {d.id: i for i, d in enumerate(flat)}
        findings.sort(key=lambda f: (
            f.scope != FindingScope.REQUIREMENT,
            min((order.get(r, 10**6) for r in f.requirement_ids), default=10**6),
            SEVERITY_RANK[f.severity],
            min((s for s, _ in f.spans), default=0),
        ))
        for i, f in enumerate(findings, 1):
            f.id = f"D-{i:03d}"

        report_findings = [self._finding(f) for f in findings]
        requirements = [
            Requirement(id=d.id, source_id=d.source_id, parent_id=d.parent_id, kind=d.kind, summary=d.summary,
                        location=self.location(d.start, d.end))
            for d in flat
        ]
        assessments = [self._assess(d.id, findings, na.get(d.id, set())) for d in flat]
        set_assessment = self._set_assess(findings, set_checks)
        checklist = self._checklist(report_findings, drafts) if self.options.fill_checklist else []

        by_sev = {s: sum(1 for f in findings if f.severity == s) for s in Severity}
        summary = Summary(
            requirements_total=len(requirements), findings_total=len(findings), by_severity=by_sev,
            critical_finding_ids=[f.id for f in findings if f.severity == Severity.CRITICAL],
        )
        self.progress(RunStage.VERIFYING, 0.95, "Итог проверки")
        conclusion = self._conclusion(findings, summary, len(requirements))

        usage = Usage.model_validate(getattr(self.client, "usage", Usage()).model_dump())
        usage.duration_s = round(time.monotonic() - t0, 1)
        report = Report(
            passport=RunPassport(
                document_name=self.doc.name, document_sha256=self.doc.sha256,
                run_at=datetime.now(timezone.utc).replace(microsecond=0),
                provider=self.provider, model=self.model, agent_version=_agent_version(),
            ),
            document=self.doc, requirements=requirements, requirement_assessments=assessments,
            set_assessment=set_assessment, findings=report_findings, checklist=checklist,
            summary=summary, conclusion=conclusion, usage=usage,
        )
        self.progress(RunStage.DONE, 1.0, f"Готово: требований {len(requirements)}, дефектов {len(findings)}")
        return report

    def _finding(self, f: FindingDraft) -> Finding:
        locs = [self.location(s, e) for s, e in f.spans]
        for q in f.unverified_quotes:
            sec = self.sections.path(locs[0].char_start or 0) if locs else "Документ"
            locs.append(SourceLocation(section=sec, quote=shorten(q, 300), verified=False))
        return Finding(
            id=f.id, scope=f.scope, requirement_ids=f.requirement_ids, criterion=f.criterion, severity=f.severity,
            title=f.title, explanation=f.explanation, locations=locs, suggestion=f.suggestion, source=f.source,
        )

    @staticmethod
    def _assess(rid: str, findings: list[FindingDraft], na: set[Criterion]) -> RequirementAssessment:
        checks = []
        for c in REQUIREMENT_CRITERIA:
            fs = [f for f in findings if rid in f.requirement_ids and f.criterion == c]
            if fs:
                checks.append(CriterionCheck(criterion=c, verdict=CheckVerdict.FAIL,
                                             comment="; ".join(f.title for f in fs), finding_ids=[f.id for f in fs]))
            elif c in na:
                checks.append(CriterionCheck(criterion=c, verdict=CheckVerdict.NOT_APPLICABLE))
            else:
                checks.append(CriterionCheck(criterion=c, verdict=CheckVerdict.PASS))
        return RequirementAssessment(requirement_id=rid, checks=checks)

    @staticmethod
    def _set_assess(findings: list[FindingDraft], llm_checks: dict[Criterion, Any]) -> SetAssessment:
        checks = []
        for c in SET_CRITERIA:
            fs = [f for f in findings if f.criterion == c]
            llm = llm_checks.get(c)
            comment = (llm.comment.strip() if llm and llm.comment else "") or None
            if fs:
                checks.append(CriterionCheck(criterion=c, verdict=CheckVerdict.FAIL,
                                             comment=comment or "; ".join(f.title for f in fs[:3]),
                                             finding_ids=[f.id for f in fs]))
            elif llm:
                checks.append(CriterionCheck(criterion=c, verdict=llm.verdict, comment=comment))
            else:
                checks.append(CriterionCheck(criterion=c, verdict=CheckVerdict.PASS,
                                             comment="Нарушений не выявлено"))
        return SetAssessment(checks=checks)

    def _findings_brief(self, findings: list[Any], limit: int = 120) -> str:
        out = []
        for f in findings[:limit]:
            out.append(f"- {f.id} [{f.severity.value}, {f.criterion.value}, "
                       f"{', '.join(f.requirement_ids) or 'набор'}] {f.title}")
        return "\n".join(out) or "- (дефектов нет)"

    def _checklist(self, findings: list[Finding], drafts: list[ReqDraft]) -> list[ChecklistItem]:
        items = extract_checklist(self.text, self.sections)
        if not items:
            return []
        self.progress(RunStage.VERIFYING, 0.92, "Заполнение чек-листа ревью")
        res = self.ask(prompts.CHECKLIST_TASK.format(
            items="\n".join(f"{i}. {q}" for i, (q, _) in enumerate(items, 1)),
            findings=self._findings_brief(findings), reqs=self.reqs_list(drafts),
            doc=prompts.doc_block(self.text, self.s.context_chars)),
            ChecklistResult, "чек-лист")
        answers = {it.index: it for it in (res.items if res else [])}
        valid = {f.id for f in findings}
        out = []
        for i, (q, _) in enumerate(items, 1):
            a = answers.get(i)
            if a:
                out.append(ChecklistItem(question=q, answer=a.answer, comment=a.comment.strip() or "—",
                                         finding_ids=[x for x in a.finding_ids if x in valid]))
            else:
                out.append(self._checklist_fallback(q, findings))
        return out

    @staticmethod
    def _checklist_fallback(q: str, findings: list[Finding]) -> ChecklistItem:
        ql = q.lower()
        rules = [
            ("противореч", {Criterion.SET_CONSISTENT, Criterion.CORRECT}),
            ("протестир", {Criterion.VERIFIABLE}),
            ("верси", {Criterion.SET_MODIFIABLE}),
            ("структурирован", {Criterion.CONFORMING, Criterion.SET_COMPREHENSIBLE}),
            ("покрывает", {Criterion.SET_COMPLETE, Criterion.COMPLETE}),
        ]
        for key, crits in rules:
            if key in ql:
                rel = [f.id for f in findings if f.criterion in crits]
                return ChecklistItem(
                    question=q, answer=ChecklistAnswer.NO if rel else ChecklistAnswer.YES,
                    comment="Есть связанные дефекты." if rel else "Связанных дефектов не найдено.",
                    finding_ids=rel[:10])
        return ChecklistItem(question=q, answer=ChecklistAnswer.NO,
                             comment="Агент не смог оценить пункт автоматически — требуется ручная проверка.")

    def _conclusion(self, findings: list[FindingDraft], summary: Summary, n_req: int) -> Conclusion:
        n_crit = summary.by_severity[Severity.CRITICAL]
        n_major = summary.by_severity[Severity.MAJOR]
        blocking_major = [f for f in findings if f.severity == Severity.MAJOR
                          and f.criterion in (Criterion.VERIFIABLE, Criterion.UNAMBIGUOUS, Criterion.COMPLETE)]
        dev = n_crit == 0 and n_req > 0
        test = dev and not blocking_major
        res = self.ask(prompts.CONCLUSION_TASK.format(
            dev="да" if dev else "нет", test="да" if test else "нет", n_req=n_req, n_find=len(findings),
            n_crit=n_crit, n_major=n_major, n_minor=summary.by_severity[Severity.MINOR],
            findings=self._findings_brief(findings)), ConclusionResult, "итог")
        ordered = sorted(findings, key=lambda f: SEVERITY_RANK[f.severity])
        if res and res.rationale.strip():
            rationale = res.rationale.strip()
            fixes = [x.strip() for x in res.top_fixes if x.strip()]
        else:
            if n_req == 0:
                rationale = "Агент не выделил в документе ни одного требования — документ нельзя передавать в работу."
            elif dev and test:
                rationale = "Критичных дефектов не найдено; оставшиеся замечания можно исправить параллельно с работой."
            else:
                crit_ids = ", ".join(f.id for f in ordered if f.severity == Severity.CRITICAL) or "—"
                rationale = (f"Найдено критичных дефектов: {n_crit} ({crit_ids}), существенных: {n_major}. "
                             "До их исправления реализация и тестирование потребуют домысливания требований.")
            fixes = []
        if not fixes:
            fixes = [f"{f.id}: {f.title}" for f in ordered if f.severity != Severity.MINOR][:7]
        if self.warnings:
            rationale += (f" Внимание: {len(self.warnings)} шаг(а) проверки не выполнены моделью "
                          f"({'; '.join(w.split(':')[0] for w in self.warnings[:5])}) — отчёт может быть неполным.")
        return Conclusion(ready_for_development=dev, ready_for_testing=test, rationale=rationale, top_fixes=fixes)


def _agent_version() -> str:
    from .version import agent_version

    return agent_version()


def run_pipeline(doc: ParsedDocument, client: Any, *, options: ValidationOptions | None = None,
                 on_progress: ProgressCallback | None = None, provider: str = "", model: str = "") -> Report:
    progress = Progress(on_progress)
    pipe = Pipeline(doc, client, options or ValidationOptions(), progress,
                    provider or getattr(client, "provider", ""), model or getattr(client, "model", ""))
    return pipe.run()
