"""Конвейер проверки: нарезка → правила → проверка требований → рецензенты набора (6 ролей) →
проверка цитат кодом → верификатор (опровержение + слияние дублей) → чек-лист → уточняющие вопросы → итог.

Рецензенты по ролям, верификатор и уточняющие вопросы перенесены из bbc-agent (validator/agents)."""

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
    ClarifyingQuestion,
    Conclusion,
    Criterion,
    CriterionCheck,
    Finding,
    FindingScope,
    FindingSource,
    ParsedDocument,
    ProgressCallback,
    ProgressEvent,
    QuestionPriority,
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
    DedupResult,
    Issue,
    QuestionsResult,
    RequirementBatchResult,
    RoleReviewResult,
    SegmentationResult,
    SetCheck,
    VerifierDecision,
    VerifierResult,
)
from .text import QuoteLocator, SectionIndex, clean_inline, page_for, shorten

log = logging.getLogger("req_core.pipeline")

SEVERITY_RANK = {Severity.CRITICAL: 0, Severity.MAJOR: 1, Severity.MINOR: 2}


class Settings:
    """Параметры прогона — только из ValidationOptions (окружение ядро не читает)."""

    context_chars = 150_000  # текст документа в промпте
    segment_chunk_chars = 40_000  # фрагмент документа для нарезки
    verify_batch = 20  # замечаний в одном запросе верификатора
    verify_retry_batch = 8  # замечания без ответа верификатора — повторно, маленькими пачками
    dedup_rows = 140  # замечаний в одном запросе на слияние дублей

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


FOREIGN_SCRIPT = re.compile(r"[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]+")


def _clean(s: str | None) -> str | None:
    if not s:
        return s
    return re.sub(r"[ \t]{2,}", " ", FOREIGN_SCRIPT.sub(" ", s)).strip()


def strip_foreign_script(report: Report) -> Report:
    """Убирает иероглифы, которые модель (напр. китайская) вставляет в русский текст. Цитаты не трогаем —
    они дословно из документа; вызывается, только если в самом документе таких символов нет."""
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
    report.conclusion.rationale = _clean(report.conclusion.rationale)
    report.conclusion.top_fixes = [_clean(x) for x in report.conclusion.top_fixes]
    return report


TITLE_LIMIT = 110


def split_title(title: str, explanation: str) -> tuple[str, str]:
    """Короткий заголовок дефекта. Если модель написала в заголовок объяснение — первая фраза идёт
    в заголовок, а полный текст переносится в объяснение (ничего не теряется)."""
    title = " ".join((title or explanation).split())
    explanation = explanation or title
    if len(title) <= TITLE_LIMIT:
        return title, explanation
    # обрезка по слову: деление по «первой фразе» рвёт «200. Created», «Content-Type: …» и теряет смысл
    short = shorten(title, TITLE_LIMIT)
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
        self.verify_stats = {"candidates": 0, "dropped": 0, "merged": 0, "unverified": 0}
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

    def parallel(self, fn: Any, items: list[Any]) -> list[Any]:
        """Запуск fn по элементам с self.s.concurrency потоками; порядок результатов сохраняется.
        При отмене (исключение из on_progress) не ждём оставшиеся задания."""
        if self.s.concurrency > 1 and len(items) > 1:
            ex = ThreadPoolExecutor(min(self.s.concurrency, len(items)))
            try:
                return list(ex.map(fn, items))
            finally:
                ex.shutdown(wait=self.progress.aborted is None, cancel_futures=True)
        return [fn(x) for x in items]

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

    def issues_to_drafts(self, issues: list[Issue], known_ids: set[str], default_scope: FindingScope,
                         origin: str = "") -> list[FindingDraft]:
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
                question=it.question.strip(), addressee=it.addressee.strip(), origin=origin,
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
            issues += self.issues_to_drafts(res.issues, ids, FindingScope.REQUIREMENT, "inspector")
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
        """Набор смотрят рецензенты с разными ролями (prompts.REVIEW_ROLES): два контролёра непротиворечивости,
        аналитик, тест-аналитик, архитектор, ИБ. Совпадающие замечания потом сливает верификатор."""
        doc = prompts.doc_block(self.text, self.s.context_chars)
        reqs = self.reqs_list(drafts)
        known_set = self.known_block([f for f in known if f.scope == FindingScope.SET])
        roles = prompts.REVIEW_ROLES
        total = len(roles)
        done = 0
        lock = threading.Lock()

        def run(role: dict) -> RoleReviewResult | None:
            nonlocal done
            user = prompts.ROLE_REVIEW_TASK.format(
                persona=role["persona"], focus=role["focus"], criteria=prompts.criteria_block(role["criteria"]),
                known=known_set, reqs=reqs, doc=doc,
            )
            res = self.ask(user, RoleReviewResult, f"рецензент «{role['title']}»")
            with lock:
                done += 1
                n = done
            self.progress(RunStage.CHECKING_SET, 0.72 + 0.12 * n / total, f"Рецензент: {role['title']}", n, total)
            return res

        with self._set_review_body():
            self.progress(RunStage.CHECKING_SET, 0.72, "Рецензенты набора", 0, total)
            results = self.parallel(run, roles)

        out: list[FindingDraft] = []
        checks: dict[Criterion, SetCheck] = {}
        for role, res in zip(roles, results):
            if not res:
                continue
            own = list(role["criteria"])
            for it in res.issues:
                if it.criterion not in SET_CRITERIA:  # рецензент отвечает за критерии набора
                    it.criterion = own[0]
            out += self.issues_to_drafts(res.issues, ids, FindingScope.SET, f"reviewer:{role['key']}")
            for c in res.checks:
                if c.criterion not in own:
                    continue
                prev = checks.get(c.criterion)
                comment = f"{role['title']}: {c.comment.strip()}" if c.comment.strip() else ""
                # нарушение хотя бы у одного рецензента важнее «выполнено» у другого
                if prev is None or (c.verdict == CheckVerdict.FAIL and prev.verdict != CheckVerdict.FAIL):
                    checks[c.criterion] = SetCheck(criterion=c.criterion, verdict=c.verdict, comment=comment)
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

    # ------------------------------------------------------------ верификатор

    def _verifier_block(self, f: FindingDraft) -> str:
        level = "набор" if f.scope == FindingScope.SET else "требование"
        src = "правило (без LLM)" if f.source == FindingSource.RULE else (f.origin or "модель")
        quotes = " / ".join(f"«{shorten(self.text[s:e], 250)}»" for s, e in f.spans)
        flag = ""
        if f.unverified_quotes:
            flag = "\n⚠ цитата модели не найдена дословно: «" + shorten(f.unverified_quotes[0], 200) + "»"
        return (f"{f.id} | уровень: {level} | {f.criterion.value} | {f.severity.value} | "
                f"{', '.join(f.requirement_ids) or 'документ в целом'} | источник: {src}\n"
                f"{f.title}\n{f.explanation}\nЦитаты: {quotes}{flag}")

    def verify(self, findings: list[FindingDraft]) -> list[FindingDraft]:
        """Верификатор пытается опровергнуть каждое замечание по тексту и выравнивает критичность.
        Замечания правил не отклоняются (только критичность). Без ответа модели замечание остаётся."""
        for i, f in enumerate(findings, 1):
            f.id = f"C-{i:03d}"
        total = len(findings)
        self.progress(RunStage.VERIFYING, 0.86, "Верификатор: перепроверка дефектов", 0, total)
        doc = prompts.doc_block(self.text, self.s.context_chars)
        checked = 0
        lock = threading.Lock()

        def run(batch: list[FindingDraft]) -> dict[str, VerifierDecision]:
            nonlocal checked
            res = self.ask(prompts.VERIFIER_TASK.format(
                findings="\n\n".join(self._verifier_block(f) for f in batch), doc=doc), VerifierResult, "верификатор")
            with lock:
                checked += len(batch)
                n = min(checked, total)
            self.progress(RunStage.VERIFYING, 0.86 + 0.02 * n / total, "Верификатор: перепроверка дефектов", n, total)
            return {d.finding_id.strip(): d for d in res.decisions} if res else {}

        b = self.s.verify_batch
        decisions: dict[str, VerifierDecision] = {}
        for part in self.parallel(run, [findings[i:i + b] for i in range(0, total, b)]):
            decisions.update(part)
        if decisions:  # модель отвечает, но часть замечаний пропустила — ещё раз маленькими пачками
            missing = [f for f in findings if f.id not in decisions]
            rb = self.s.verify_retry_batch
            for part in self.parallel(run, [missing[i:i + rb] for i in range(0, len(missing), rb)]):
                decisions.update(part)

        kept: list[FindingDraft] = []
        for f in findings:
            d = decisions.get(f.id)
            if d is None:
                self.verify_stats["unverified"] += 1
                kept.append(f)
                continue
            sev = d.severity.strip().lower()
            if sev in {x.value for x in Severity}:
                f.severity = Severity(sev)
            if d.verdict.strip().lower() == "drop" and f.source == FindingSource.LLM:
                self.verify_stats["dropped"] += 1
                log.info("Верификатор отклонил %s «%s»: %s", f.id, f.title, d.reason)
                continue
            kept.append(f)
        self.verify_stats["candidates"] = total
        return kept

    @staticmethod
    def _same_place(a: FindingDraft, b: FindingDraft) -> bool:
        return any(overlap(x, y) > 0 for x in a.spans for y in b.spans)

    @classmethod
    def _related(cls, a: FindingDraft, b: FindingDraft) -> bool:
        """Страховка от ложных слияний: дубли обязаны быть об одном месте, требовании или критерии набора."""
        if cls._same_place(a, b) or set(a.requirement_ids) & set(b.requirement_ids):
            return True
        return a.scope == b.scope == FindingScope.SET and a.criterion == b.criterion

    @staticmethod
    def _keeper_rank(f: FindingDraft) -> tuple:
        """Какое замечание группы остаётся: противоречие > уровень набора > критичность > доказательства > LLM."""
        return (
            0 if f.criterion == Criterion.SET_CONSISTENT else 1,
            0 if f.scope == FindingScope.SET else 1,
            SEVERITY_RANK[f.severity],
            -len(f.spans),
            0 if f.source == FindingSource.LLM else 1,
            f.id,
        )

    @staticmethod
    def _merge_into(keep: FindingDraft, dup: FindingDraft) -> None:
        keep.requirement_ids = list(dict.fromkeys(keep.requirement_ids + dup.requirement_ids))
        for sp in dup.spans:
            if len(keep.spans) < 4 and not any(overlap(sp, k) > 0 for k in keep.spans):
                keep.spans.append(sp)
        if SEVERITY_RANK[dup.severity] < SEVERITY_RANK[keep.severity]:
            keep.severity = dup.severity
        keep.suggestion = keep.suggestion or dup.suggestion
        if not keep.question and dup.question:
            keep.question, keep.addressee = dup.question, dup.addressee

    def _dedup_row(self, f: FindingDraft) -> str:
        level = "набор" if f.scope == FindingScope.SET else "требование"
        return (f"{f.id} | {level} | {f.criterion.value} | {f.severity.value} | "
                f"{', '.join(f.requirement_ids) or 'документ в целом'} | {f.title}. {shorten(f.explanation, 300)}")

    def llm_dedup(self, findings: list[FindingDraft]) -> list[FindingDraft]:
        """Слияние дублей в два прохода: по всему списку и по группам замечаний об одном месте документа.
        Модель предлагает группы, код решает, что объединять и какое замечание оставить."""
        if len(findings) < 2:
            return findings
        self.progress(RunStage.VERIFYING, 0.89, "Верификатор: слияние дублей")
        by_id = {f.id: f for f in findings}
        alive = set(by_id)

        def apply(res: DedupResult | None) -> None:
            for g in res.groups if res else []:
                group = [by_id[i] for i in dict.fromkeys(x.strip() for x in g.ids) if i in alive]
                if len(group) < 2:
                    continue
                group.sort(key=self._keeper_rank)
                keep = group[0]
                for dup in group[1:]:
                    if self._related(dup, keep):
                        self._merge_into(keep, dup)
                        alive.discard(dup.id)
                        self.verify_stats["merged"] += 1

        ordered = sorted(findings, key=lambda f: (min((s for s, _ in f.spans), default=0), f.id))
        n = self.s.dedup_rows
        for i in range(0, len(ordered), n):
            chunk = ordered[i:i + n]
            if len(chunk) >= 2:
                apply(self.ask(prompts.DEDUP_TASK.format(findings="\n".join(self._dedup_row(f) for f in chunk)),
                               DedupResult, "слияние дублей"))

        # проход 2: замечания об одном месте — в коротком списке модель видит такие пары сразу
        clusters: list[list[FindingDraft]] = []
        for f in [x for x in ordered if x.id in alive]:
            home = next((c for c in clusters if any(self._same_place(f, m) for m in c)), None)
            if home is None:
                clusters.append([f])
            else:
                home.append(f)
        blocks = []
        for c in clusters:
            if len(c) < 2:
                continue
            where = sorted({self.sections.path(s) for f in c for s, _ in f.spans[:1]})
            blocks.append(f"--- одно место документа ({'; '.join(where[:2])}) ---\n"
                          + "\n".join(self._dedup_row(f) for f in c))
        if blocks:
            apply(self.ask(prompts.DEDUP_TASK.format(findings="\n".join(blocks)), DedupResult,
                           "слияние дублей: одно место документа"))
        return [f for f in findings if f.id in alive]

    # ------------------------------------------------------------ уточняющие вопросы

    def clarifying_questions(self, findings: list[FindingDraft]) -> list[ClarifyingQuestion]:
        """Закрытые вопросы автору с вариантами ответа. Без ответа модели — вопросы, предложенные рецензентами."""
        limit = self.options.max_questions
        if not self.options.ask_questions or limit <= 0 or not findings:
            return []
        self.progress(RunStage.VERIFYING, 0.93, "Уточняющие вопросы автору")
        ordered = sorted(findings, key=lambda f: SEVERITY_RANK[f.severity])
        rows = "\n".join(
            f"{f.id} | {f.severity.value} | {', '.join(f.requirement_ids) or 'набор'} | {f.title}. "
            f"{shorten(f.explanation, 220)} | {f.question or '—'}"
            for f in ordered[:120]
        )
        res = self.ask(prompts.QUESTIONS_TASK.format(
            limit=limit, findings=rows, doc=prompts.doc_block(self.text, self.s.context_chars)),
            QuestionsResult, "уточняющие вопросы")
        valid = {f.id for f in findings}
        prio = {p.value: p for p in QuestionPriority}
        items: list[ClarifyingQuestion] = []
        seen: set[str] = set()
        if res and res.questions:
            for q in res.questions:
                text = " ".join(q.question.split())
                if not text or text.lower() in seen:
                    continue
                seen.add(text.lower())
                items.append(ClarifyingQuestion(
                    id="", question=text, why=" ".join(q.why.split()) or "Без ответа требование трактуется по-разному.",
                    addressee=q.addressee.strip() or "Аналитик",
                    priority=prio.get(q.priority.strip().lower(), QuestionPriority.IMPORTANT),
                    finding_ids=[x for x in dict.fromkeys(i.strip() for i in q.finding_ids) if x in valid],
                    options=[" ".join(o.split()) for o in q.options if o.strip()][:4],
                ))
        else:
            for f in ordered:
                text = " ".join(f.question.split())
                if not text or text.lower() in seen:
                    continue
                seen.add(text.lower())
                items.append(ClarifyingQuestion(
                    id="", question=text, why=f"Без ответа не закрыть {f.id}: {f.title}",
                    addressee=f.addressee or "Аналитик",
                    priority=QuestionPriority.BLOCKER if f.severity == Severity.CRITICAL else QuestionPriority.IMPORTANT,
                    finding_ids=[f.id],
                ))
        rank = {QuestionPriority.BLOCKER: 0, QuestionPriority.IMPORTANT: 1, QuestionPriority.MINOR: 2}
        items = sorted(items, key=lambda q: rank[q.priority])[:limit]
        for i, q in enumerate(items, 1):
            q.id = f"Q-{i:02d}"
        return items

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

        for f in rules:
            f.origin = f.origin or "rules"
        findings = self.resolve_quotes(req_issues + set_issues + rules, req_by_id)
        findings = self.dedupe(findings)
        if self.options.verify_pass and findings:
            findings = self.verify(findings)
            findings = self.llm_dedup(findings)
            v = self.verify_stats
            log.info("Верификатор: кандидатов %s, отклонено %s, слито дублей %s, без ответа %s",
                     v["candidates"], v["dropped"], v["merged"], v["unverified"])

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
        questions = self.clarifying_questions(findings)

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
            set_assessment=set_assessment, findings=report_findings, checklist=checklist, questions=questions,
            summary=summary, conclusion=conclusion, usage=usage,
        )
        if not FOREIGN_SCRIPT.search(self.doc.text):
            report = strip_foreign_script(report)
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
