"""Рендер отчёта: Markdown (основной формат), JSON, DOCX и PDF.

DOCX и тело PDF строятся из того же Markdown (подмножество: заголовки, абзацы, списки, таблицы, жирный),
поэтому содержание всех форматов совпадает. У PDF есть ещё титульная страница (см. `req_core.pdf`).
"""

from __future__ import annotations

import io
import os
import re
from collections import Counter
from pathlib import Path

from req_contracts import (
    CRITERIA,
    Decision,
    DefectType,
    Grounding,
    REQUIREMENT_CRITERIA,
    CheckVerdict,
    ChecklistAnswer,
    Finding,
    FindingScope,
    FindingSource,
    QuestionPriority,
    Report,
    RequirementKind,
    Severity,
    SourceLocation,
)

KIND_RU = {
    RequirementKind.FUNCTIONAL: "Функциональное",
    RequirementKind.NON_FUNCTIONAL: "Нефункциональное",
    RequirementKind.DATA: "К данным",
    RequirementKind.INTEGRATION: "Интеграция",
    RequirementKind.API: "API",
    RequirementKind.UI: "UI",
    RequirementKind.ACCEPTANCE: "Критерий приёмки",
    RequirementKind.OTHER: "Прочее",
}
SEV_RU = {Severity.CRITICAL: "Критично", Severity.MAJOR: "Существенно", Severity.MINOR: "Незначительно"}
VERDICT_RU = {CheckVerdict.PASS: "✔ соответствует", CheckVerdict.FAIL: "✘ нарушение",
              CheckVerdict.NOT_APPLICABLE: "— неприменимо"}
ANSWER_RU = {ChecklistAnswer.YES: "Да", ChecklistAnswer.NO: "Нет", ChecklistAnswer.PARTIAL: "Частично",
             ChecklistAnswer.NOT_REQUIRED: "Не требуется"}
DECISION_RU = {Decision.BLOCKED: "Нельзя начинать разработку и тестирование",
               Decision.LIMITED: "Можно с ограничениями — по части требований",
               Decision.READY: "Можно начинать разработку и тестирование"}
DEFECT_RU = {
    DefectType.UNVERIFIABLE: "непроверяемое", DefectType.CONTRADICTORY: "противоречивое",
    DefectType.INCOMPLETE: "неполное", DefectType.AMBIGUOUS: "двусмысленное",
    DefectType.DESIGN: "лишнее проектное решение", DefectType.NOT_SINGULAR: "неатомарное",
    DefectType.INFEASIBLE: "неосуществимое", DefectType.INCORRECT: "некорректное",
    DefectType.NONCONFORMING: "нарушение оформления", DefectType.UNTRACEABLE: "непрослеживаемое",
    DefectType.REDUNDANT: "избыточное / дублирующее", DefectType.RISK: "операционный риск / ИБ",
}
GROUNDING_RU = {Grounding.EXACT: "цитата совпала дословно", Grounding.FUZZY: "цитата с искажением, показан текст документа",
                Grounding.LINE: "слабая привязка: цитата не найдена, показан текст указанной строки"}
AGENT_RU = {
    "inspector": "инспектор", "reviewer:consistency": "контролёр логики правил",
    "reviewer:contract": "контролёр согласованности спецификаций", "reviewer:analyst": "системный аналитик",
    "reviewer:qa": "тест-аналитик", "reviewer:architect": "архитектор интеграций",
    "reviewer:security": "аналитик рисков и ИБ",
}
PRIORITY_RU = {QuestionPriority.BLOCKER: "Блокирующий", QuestionPriority.IMPORTANT: "Важный",
               QuestionPriority.MINOR: "Желательный"}


def _one_line(s: str) -> str:
    return " ".join((s or "").split())


def _short(s: str, n: int) -> str:
    s = _one_line(s)
    return s if len(s) <= n else s[: n - 1].rstrip() + "…"


def _cell(s: str) -> str:
    return (s or "").replace("\\", "\\\\").replace("|", "\\|").replace("\r", "").replace("\n", "<br>")


def _row(*cells: str) -> str:
    return "| " + " | ".join(_cell(c) for c in cells) + " |"


def _table(header: list[str], rows: list[list[str]]) -> list[str]:
    return [_row(*header), "| " + " | ".join([":---"] * len(header)) + " |", *[_row(*r) for r in rows]]


def _crit(c) -> str:
    info = CRITERIA[c]
    return f"{info.title_ru} ({', '.join(info.references)})"


def _lines(loc: SourceLocation) -> str:
    if loc.line_start is None:
        return "—"
    return f"{loc.line_start}" if loc.line_end in (None, loc.line_start) else f"{loc.line_start}–{loc.line_end}"


def _where(loc: SourceLocation) -> str:
    parts = [loc.section]
    if loc.page:
        parts.append(f"стр. {loc.page}")
    if loc.line_start is not None:
        parts.append(("строка " if loc.line_end in (None, loc.line_start) else "строки ") + _lines(loc))
    elif loc.char_start is not None and loc.char_end is not None:
        parts.append(f"символы {loc.char_start}–{loc.char_end}")
    mark = "цитата подтверждена в тексте" if loc.verified else "⚠ цитата модели не найдена в тексте дословно"
    return ", ".join(parts) + f" ({mark})"


def _check_comment(c) -> str:
    """«D-003: комментарий», «D-003» или «комментарий» — без висячего двоеточия."""
    return ": ".join(x for x in (", ".join(c.finding_ids), _one_line(c.comment or "")) if x)


def _finding_block(f: Finding) -> list[str]:
    src = "правило (без LLM)" if f.source == FindingSource.RULE else "модель (LLM)"
    out = [f"#### {f.id} · {SEV_RU[f.severity]} · {CRITERIA[f.criterion].title_ru} — {_one_line(f.title)}", ""]
    if f.requirement_ids:
        out.append(f"- **Требования:** {', '.join(f.requirement_ids)}")
    for i, loc in enumerate(f.locations, 1):
        suffix = f" {i}" if len(f.locations) > 1 else ""
        out.append(f"- **Где{suffix}:** {_where(loc)}")
        out.append(f"- **Цитата{suffix}:** «{_short(loc.quote, 700)}»")
    out.append(f"- **Почему это нарушение:** {_one_line(f.explanation)}")
    if f.suggestion:
        out.append(f"- **Как исправить:** {_one_line(f.suggestion)}")
    if f.defect_type:
        out.append(f"- **Тип дефекта:** {DEFECT_RU[f.defect_type]}")
    out.append(f"- **Критерий:** {_crit(f.criterion)}; источник: {src}")
    if f.found_by:
        out.append(f"- **Кто нашёл:** {', '.join(AGENT_RU.get(a, a) for a in f.found_by)}")
    if f.grounding:
        out.append(f"- **Привязка к тексту:** {GROUNDING_RU[f.grounding]}")
    if f.verifier_note:
        out.append(f"- **Верификатор:** {_one_line(f.verifier_note)}")
    if f.resolved_by:
        out.append(f"- **Снимается ответом автора на {f.resolved_by}**")
    out.append("")
    return out


def render_markdown(report: Report) -> str:
    p = report.passport
    fby = {f.id: f for f in report.findings}
    req_by = {r.id: r for r in report.requirements}
    children: dict[str, list[str]] = {}
    for r in report.requirements:
        if r.parent_id:
            children.setdefault(r.parent_id, []).append(r.id)
    L: list[str] = []
    L += [f"# Отчёт о проверке требований: {p.document_name}", ""]
    L += [
        "Статическая проверка документа требований до разработки по ISO/IEC/IEEE 29148:2018 (п. 5.2.5, 5.2.6) "
        "и IEEE Std 830-1998 (п. 4.3). Отчёт сформирован агентом ReqCheck автоматически; каждое нарушение "
        "ссылается на место в документе и сопровождается цитатой, найденной в тексте кодом.", "",
    ]

    # 1. Паспорт
    u = report.usage
    L += ["## 1. Паспорт прогона", ""]
    rows = [
        *([["Название документа", report.document_title]] if report.document_title else []),
        ["Документ", p.document_name],
        ["SHA-256 документа", f"`{p.document_sha256}`"],
        ["Формат", report.document.format.value.upper()],
        ["Дата и время прогона", p.run_at.strftime("%d.%m.%Y %H:%M:%S UTC")],
        ["Провайдер LLM", p.provider],
        ["Модель", p.model],
        ["Версия агента", p.agent_version],
        ["Стандарты", "; ".join(p.standards)],
        ["Вызовов LLM / токенов (вход + выход)",
         f"{u.llm_calls} / {u.prompt_tokens:,} + {u.completion_tokens:,}".replace(",", " ")],
    ]
    if u.duration_s is not None:
        rows.append(["Длительность", f"{u.duration_s:.0f} с"])
    qs = report.quality
    if qs and qs.context_window:
        rows.append(["Окно модели / пик загрузки",
                     f"{qs.context_window:,} токенов / {qs.context_peak_pct or 0:g} %".replace(",", " ")
                     + (f"; документ проверялся по частям: {qs.doc_parts}" if qs.doc_parts > 1 else "")])
    if qs and qs.prompt_versions:
        rows.append(["Версии промтов", ", ".join(f"{k} v{v}" for k, v in qs.prompt_versions.items())])
    L += _table(["Параметр", "Значение"], rows) + [""]

    # 2. Нарезка
    top = [r for r in report.requirements if not r.parent_id]
    n_sub = len(report.requirements) - len(top)
    L += ["## 2. Как агент нарезал требования", ""]
    L += [f"Выделено требований: **{len(report.requirements)}** (верхнего уровня — {len(top)}, атомарных "
          f"подтребований составных — {n_sub}). Если в документе не было номера, агент присвоил свой "
          "идентификатор и сохранил цитату.", ""]
    rows = []
    for r in report.requirements:
        src = r.source_id or "— (нет, присвоен агентом)"
        if r.parent_id:
            src = f"часть {r.parent_id}" + (f" ({req_by[r.parent_id].source_id})" if req_by[r.parent_id].source_id else "")
        summary = _one_line(r.summary)
        quote = _one_line(r.location.quote)
        same = _plain(quote).startswith(summary.rstrip("…").rstrip()) or summary == ""
        head = "" if same else f"**{summary}**<br>"
        rows.append([
            r.id, src, KIND_RU[r.kind],
            f"{head}«{_short(quote, 220)}»<br>*{r.location.section}"
            + (f", стр. {r.location.page}" if r.location.page else "") + "*",
        ])
    L += _table(["ID в отчёте", "ID в документе", "Тип", "Формулировка и цитата"], rows) + [""]
    if qs and (qs.extracted_by_coverage or qs.extracted_first_pass):
        L += [f"Первый проход нарезки — {qs.extracted_first_pass} требований; контроль покрытия добавил "
              f"{qs.extracted_by_coverage} (строки, не вошедшие ни в одно требование, перепроверены моделью).", ""]
    if report.skipped:
        L += ["### Фрагменты, которые агент не счёл требованиями", ""]
        L += _table(["Строки", "Текст", "Причина"], [
            [_lines(k.location), f"«{_short(k.location.quote, 160)}»", _one_line(k.reason)] for k in report.skipped
        ]) + [""]

    # 3. Проверка каждого требования
    L += ["## 3. Проверка каждого требования", ""]
    L += ["Каждое требование проверено по критериям отдельного требования: "
          + ", ".join(CRITERIA[c].title_ru.lower() for c in REQUIREMENT_CRITERIA) + ".", ""]
    shown: set[str] = set()
    assess = {a.requirement_id: a for a in report.requirement_assessments}
    for r in report.requirements:
        title = f"### {r.id}"
        if r.source_id:
            title += f" ({r.source_id})"
        if r.parent_id:
            title += f" — часть {r.parent_id}"
        title += f" — {_one_line(r.summary)}"
        L += [title, ""]
        L += [f"- **Тип:** {KIND_RU[r.kind]}", f"- **Где:** {_where(r.location)}",
              f"- **Текст:** «{_short(r.location.quote, 900)}»"]
        if children.get(r.id):
            L.append(f"- **Составное требование**, атомарные части: {', '.join(children[r.id])}")
        L.append("")
        a = assess.get(r.id)
        if a:
            fails = [c for c in a.checks if c.verdict == CheckVerdict.FAIL]
            L += _table(["Критерий", "Результат", "Комментарий"], [
                [_crit(c.criterion), VERDICT_RU[c.verdict],
                 _check_comment(c)]
                for c in a.checks
            ]) + [""]
            if not fails:
                L += ["Нарушений по критериям отдельного требования не выявлено.", ""]
        own = [f for f in report.findings if r.id in f.requirement_ids and f.scope == FindingScope.REQUIREMENT]
        for f in own:
            if f.id in shown:
                L += [f"- {f.id} — {_one_line(f.title)} (подробно см. выше, у {f.requirement_ids[0]})", ""]
                continue
            shown.add(f.id)
            L += _finding_block(f)
        set_refs = [f for f in report.findings if r.id in f.requirement_ids and f.scope == FindingScope.SET]
        if set_refs:
            L += ["Также затрагивают это требование дефекты набора (раздел 4): "
                  + "; ".join(f"{f.id} — {_one_line(f.title)}" for f in set_refs), ""]

    # 4. Проверка набора
    L += ["## 4. Проверка всего набора требований", ""]
    L += _table(["Критерий набора", "Результат", "Комментарий"], [
        [_crit(c.criterion), VERDICT_RU[c.verdict],
         _check_comment(c) + (f" (оценили: {', '.join(c.assessed_by)})" if c.assessed_by else "")]
        for c in report.set_assessment.checks
    ]) + [""]
    set_f = [f for f in report.findings if f.scope == FindingScope.SET]
    if set_f:
        L += ["### Дефекты набора", ""]
        for f in set_f:
            L += _finding_block(f)
    else:
        L += ["Дефектов уровня набора не выявлено.", ""]

    # 5. Чек-лист
    if report.checklist:
        L += ["## 5. Чек-лист «Ревью требований» (заполнен агентом)", ""]
        L += _table(["№", "Пункт чек-листа", "Ответ агента", "Комментарий", "Дефекты"], [
            [str(i), _one_line(c.question), ANSWER_RU[c.answer], _one_line(c.comment), ", ".join(c.finding_ids)]
            for i, c in enumerate(report.checklist, 1)
        ]) + [""]

    # Уточняющие вопросы автору
    n = 6 if report.checklist else 5
    if report.questions:
        L += [f"## {n}. Уточняющие вопросы автору документа", ""]
        L += ["Без ответов на эти вопросы команда не может однозначно реализовать и протестировать требования. "
              "Сначала — блокирующие.", ""]
        for q in report.questions:
            L += [f"#### {q.id} · {PRIORITY_RU[q.priority]} · кому: {_one_line(q.addressee)}", ""]
            L.append(f"- **Вопрос:** {_one_line(q.question)}")
            L.append(f"- **Почему важно:** {_one_line(q.why)}")
            if q.options:
                L.append("- **Варианты ответа:** " + "; ".join(f"({chr(0x430 + i)}) {_one_line(o)}"
                                                            for i, o in enumerate(q.options)))
            if q.finding_ids:
                L.append(f"- **Связанные дефекты:** {', '.join(q.finding_ids)}")
            if q.answer:
                L.append(f"- **Ответ автора:** {_one_line(q.answer)}")
            if q.resolution:
                for rw in q.resolution.rewrites:
                    L.append(f"- **Новая редакция {rw.requirement_id}:** {_one_line(rw.new_text)}")
                if q.resolution.closes_findings:
                    L.append(f"- **Снимает дефекты:** {', '.join(q.resolution.closes_findings)}")
                if q.resolution.note:
                    L.append(f"- **Примечание:** {_one_line(q.resolution.note)}")
            L.append("")
        n += 1

    # Сводка
    s = report.summary
    verified = sum(1 for f in report.findings if any(loc.verified for loc in f.locations))
    L += [f"## {n}. Сводка", ""]
    L += [
        f"- **Требований:** {s.requirements_total} (верхнего уровня — {len(top)}, подтребований — {n_sub})",
        f"- **Нарушений:** {s.findings_total} — критичных {s.by_severity.get(Severity.CRITICAL, 0)}, "
        f"существенных {s.by_severity.get(Severity.MAJOR, 0)}, незначительных {s.by_severity.get(Severity.MINOR, 0)}",
        f"- **Подтверждено цитатой в тексте документа:** {verified} из {s.findings_total}",
        f"- **Требований без нарушений:** "
        + (", ".join(r.id for r in report.requirements
                     if not any(r.id in f.requirement_ids for f in report.findings)) or "нет"),
        "",
    ]
    by_c = Counter(f.criterion for f in report.findings)
    if by_c:
        L += ["### Нарушения по критериям", ""]
        L += _table(["Критерий", "Нарушений"], [[_crit(c), str(k)] for c, k in by_c.most_common()]) + [""]
    L += ["### Критичные дефекты (непроверяемые, противоречивые, неполные формулировки)", ""]
    crit = [fby[i] for i in s.critical_finding_ids if i in fby]
    if crit:
        L += _table(["Дефект", "Требования", "Критерий", "Суть", "Место"], [
            [f.id, ", ".join(f.requirement_ids) or "набор", CRITERIA[f.criterion].title_ru, _one_line(f.title),
             f"{f.locations[0].section}: «{_short(f.locations[0].quote, 120)}»"]
            for f in crit
        ]) + [""]
    else:
        L += ["Критичных дефектов не найдено.", ""]
    if qs:
        L += ["### Контроль достоверности и покрытия", ""]
        rows = [
            ["Кандидатов в замечания от всех агентов", str(qs.candidates)],
            ["Отклонено кодом (цитата не найдена или выдумана)", str(qs.rejected_by_code)],
            ["Отклонено верификатором", str(qs.rejected_by_verifier)],
            ["Слито дублей", str(qs.merged)],
            ["Подтверждено", str(qs.confirmed)],
            ["Привязка цитат: дословно / с искажением / по строке",
             f"{qs.evidence_exact} / {qs.evidence_fuzzy} / {qs.evidence_line}"],
            ["Матрица «требование × критерий»: заполнено", f"{qs.matrix_cells_filled} из {qs.matrix_cells_total}"
             + (f" (раундов: {qs.rounds})" if qs.rounds else "")],
        ]
        if qs.unverified:
            rows.append(["Оставлено без ответа верификатора", str(qs.unverified)])
        if qs.inline_quotes_unverified:
            rows.append(["Цитаты в тексте замечаний, которых нет в документе", str(qs.inline_quotes_unverified)])
        if qs.removed_refs:
            rows.append(["Удалено ссылок на несуществующие требования и замечания", str(qs.removed_refs)])
        if qs.uncovered_requirements:
            rows.append(["Не проверены по всем критериям", ", ".join(qs.uncovered_requirements)])
        if qs.reviews_failed:
            rows.append(["Рецензенты без ответа", ", ".join(AGENT_RU.get("reviewer:" + k, k) for k in qs.reviews_failed)])
        L += _table(["Показатель", "Значение"], rows) + [""]

    # Итог
    c = report.conclusion
    L += [f"## {n + 1}. Итог", ""]
    if c.decision:
        L += [f"**Решение: {DECISION_RU[c.decision]}.**" + (f" *({c.guard_note})*" if c.guard_note else ""), ""]
    L += [f"- **Можно начинать разработку:** {'да' if c.ready_for_development else 'нет'}",
          f"- **Можно начинать тестирование:** {'да' if c.ready_for_testing else 'нет'}", ""]
    L += [_one_line(c.rationale), ""]
    if c.development:
        L += [f"**Разработка.** {_one_line(c.development)}", ""]
    if c.testing:
        L += [f"**Тестирование.** {_one_line(c.testing)}", ""]
    if c.fixes:
        L += ["**Что исправить в первую очередь:**", ""]
        L += [f"{i}. {_one_line(fx.action)}" + (f" — {_one_line(fx.why)}" if fx.why else "")
              + (f" ({', '.join(fx.finding_ids)})" if fx.finding_ids else "")
              for i, fx in enumerate(c.fixes, 1)] + [""]
    elif c.top_fixes:
        L += ["**Что исправить в первую очередь:**", ""]
        L += [f"{i}. {_one_line(x)}" for i, x in enumerate(c.top_fixes, 1)] + [""]
    if c.strengths:
        L += ["**Сильные стороны документа:**", ""]
        L += [f"- {_one_line(x)}" for x in c.strengths] + [""]

    L += ["---", "",
          f"*Методика bbc-agent: нарезка требований в два прохода (модель + контроль покрытия + кандидаты правил), "
          f"детерминированные правила как подсказки агентам, инспектор по матрице «требование × критерий» с раундами "
          f"до полного покрытия, шесть рецензентов набора с разными ролями, контроль достоверности кодом (цитаты, "
          f"ссылки), верификатор (опровержение и слияние дублей), уточняющие вопросы автору и итог руководителя ревью. "
          f"Агент ReqCheck {p.agent_version}, схема отчёта {report.schema_version}.*", ""]
    return "\n".join(L)


# ---------------------------------------------------------------- разбор markdown-подмножества

_INLINE = re.compile(r"(\*\*[^*]+?\*\*|`[^`]+`|(?<![\w*])\*[^*\n]+?\*(?![\w*]))")


def _inline_segments(s: str) -> list[tuple[str, str]]:
    """[(стиль, текст)], стиль: '' | 'B' | 'I' | 'C'."""
    s = s.replace("<br>", "\n").replace("\\|", "|").replace("\\\\", "\\")
    out = []
    for part in _INLINE.split(s):
        if not part:
            continue
        if part.startswith("**") and part.endswith("**") and len(part) > 4:
            out.append(("B", part[2:-2]))
        elif part.startswith("`") and part.endswith("`") and len(part) > 2:
            out.append(("C", part[1:-1]))
        elif part.startswith("*") and part.endswith("*") and len(part) > 2:
            out.append(("I", part[1:-1]))
        else:
            out.append(("", part))
    return out


def _plain(s: str) -> str:
    return "".join(t for _, t in _inline_segments(s))


def _split_md_row(line: str) -> list[str]:
    s = line.strip()
    s = s[1:] if s.startswith("|") else s
    s = s[:-1] if s.endswith("|") and not s.endswith("\\|") else s
    return [c.strip() for c in re.split(r"(?<!\\)\|", s)]


def _blocks(md: str):
    lines = md.split("\n")
    i = 0
    while i < len(lines):
        ln = lines[i]
        if ln.startswith("|") and i + 1 < len(lines) and re.match(r"^\|\s*:?-{3}", lines[i + 1]):
            header = _split_md_row(ln)
            rows = []
            i += 2
            while i < len(lines) and lines[i].startswith("|"):
                rows.append(_split_md_row(lines[i]))
                i += 1
            yield ("table", header, rows)
            continue
        m = re.match(r"^(#{1,6})\s+(.*)$", ln)
        if m:
            yield ("heading", len(m.group(1)), m.group(2))
        elif re.match(r"^\s*-\s+", ln):
            yield ("bullet", re.sub(r"^\s*-\s+", "", ln))
        elif re.match(r"^\d+\.\s+", ln):
            yield ("number", ln)
        elif ln.strip() == "---":
            yield ("rule",)
        elif ln.strip():
            yield ("para", ln)
        i += 1


# ---------------------------------------------------------------- DOCX


def render_docx(md: str) -> bytes:
    from docx import Document
    from docx.enum.section import WD_ORIENT  # noqa: F401
    from docx.shared import Cm, Pt

    doc = Document()
    sec = doc.sections[0]
    sec.left_margin = sec.right_margin = Cm(1.8)
    style = doc.styles["Normal"]
    style.font.name = "Calibri"
    style.font.size = Pt(10)

    def add_runs(par, text: str) -> None:
        for st, t in _inline_segments(text):
            run = par.add_run(t)
            run.bold = st == "B"
            run.italic = st == "I"
            if st == "C":
                run.font.name = "Consolas"

    for b in _blocks(md):
        kind = b[0]
        if kind == "heading":
            doc.add_heading(_plain(b[2]), level=min(b[1] - 1, 4) if b[1] > 1 else 0)
        elif kind == "table":
            header, rows = b[1], b[2]
            t = doc.add_table(rows=1, cols=len(header))
            t.style = "Table Grid"
            for j, h in enumerate(header):
                p = t.rows[0].cells[j].paragraphs[0]
                r = p.add_run(_plain(h))
                r.bold = True
            for row in rows:
                cells = t.add_row().cells
                for j in range(len(header)):
                    add_runs(cells[j].paragraphs[0], row[j] if j < len(row) else "")
            doc.add_paragraph()
        elif kind == "bullet":
            add_runs(doc.add_paragraph(style="List Bullet"), b[1])
        elif kind == "number":
            add_runs(doc.add_paragraph(), b[1])
        elif kind == "para":
            add_runs(doc.add_paragraph(), b[1])
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


# ---------------------------------------------------------------- PDF

FONT_DIRS = [
    os.environ.get("REQCHECK_PDF_FONT_DIR", ""),
    "/usr/share/fonts/truetype/dejavu",
    "/usr/share/fonts/dejavu",
    "C:/Windows/Fonts",
]


def _find_font() -> tuple[str, str]:
    for d in FONT_DIRS:
        if not d:
            continue
        reg, bold = Path(d) / "DejaVuSans.ttf", Path(d) / "DejaVuSans-Bold.ttf"
        if reg.is_file():
            return str(reg), str(bold if bold.is_file() else reg)
    raise RuntimeError("Не найден шрифт DejaVuSans.ttf для PDF (apt install fonts-dejavu-core "
                       "или REQCHECK_PDF_FONT_DIR)")


def render_pdf(report: Report, md: str | None = None) -> bytes:
    """PDF: титульная страница из `Report` + тело из того же Markdown (вёрстка — в `req_core.pdf`)."""
    from .pdf import render_pdf_report

    return render_pdf_report(report, md)


# ---------------------------------------------------------------- вход


def render_report(report: Report, fmt: str) -> bytes:
    if fmt == "json":
        return report.model_dump_json(indent=2).encode("utf-8")
    md = render_markdown(report)
    if fmt == "md":
        return md.encode("utf-8")
    if fmt == "docx":
        return render_docx(md)
    if fmt == "pdf":
        return render_pdf(report, md)
    raise ValueError(f"Неизвестный формат отчёта: {fmt} (md, json, docx, pdf)")
