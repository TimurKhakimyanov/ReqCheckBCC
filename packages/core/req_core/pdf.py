"""PDF-отчёт: титульная страница (вердикт, показатели, что исправить, содержание) и вёрстка тела.

Тело строится из того же Markdown, что и DOCX/MD (`render.render_markdown`), поэтому содержание
форматов совпадает; титульная страница собирается напрямую из `Report` — никаких чисел сверх отчёта.
PDF рендерится в два прохода: первый узнаёт страницы разделов и общее число страниц, второй печатает
их в содержании и колонтитулах.
"""

from __future__ import annotations

import math
import re
from pathlib import Path

from fpdf import FPDF
from fpdf.fonts import FontFace
from req_contracts import Decision, QuestionPriority, Report, Severity

from .render import (
    PRIORITY_RU,
    SEV_RU,
    _blocks,
    _find_font,
    _inline_segments,
    _one_line,
    _plain,
    _short,
    render_markdown,
)

RGB = tuple[int, int, int]


def _hex(s: str) -> RGB:
    s = s.lstrip("#")
    return int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16)


INK = _hex("1C1C21")
INK2 = _hex("3A3A43")
MUTED = _hex("5F5F68")
RULE = _hex("D6D6DB")
HAIR = _hex("E2E2E5")
FILL = _hex("F1F1F3")
ACCENT = _hex("D9611A")
WHITE = (255, 255, 255)
GOOD, GOOD_TINT, GOOD_DARK = _hex("2F7D4F"), _hex("EDF6F0"), _hex("23613C")

SEV_COLOR = {Severity.CRITICAL: _hex("C2551A"), Severity.MAJOR: _hex("3F5FD6"), Severity.MINOR: _hex("8A7310")}
SEV_TINT = {Severity.CRITICAL: _hex("FDF4EE"), Severity.MAJOR: _hex("EEF1FC"), Severity.MINOR: _hex("F9F5E6")}
SEV_DARK = {Severity.CRITICAL: _hex("9A3F10"), Severity.MAJOR: _hex("2E47A8"), Severity.MINOR: _hex("6B590A")}
PRIORITY_SEV = {QuestionPriority.BLOCKER: Severity.CRITICAL, QuestionPriority.IMPORTANT: Severity.MAJOR,
                QuestionPriority.MINOR: Severity.MINOR}
# Подписи уровня в заголовках находок («Критично») и вопросов («Блокирующий») → цвет чипа.
_CHIP_COLOR = {**{v: SEV_COLOR[k] for k, v in SEV_RU.items()},
               **{v: SEV_COLOR[PRIORITY_SEV[k]] for k, v in PRIORITY_RU.items()}}

MARGIN_X = 18.0
MARGIN_TOP = 20.0
MARGIN_BOTTOM = 18.0
BODY_PT = 9.5
BODY_LH = 4.9
_REF = re.compile(r"\b[DQR]-\d+(?:\.\d+)?\b")


# ---------------------------------------------------------------- данные титула


def document_title(report: Report) -> str:
    """Название документа: первый заголовок «# …» в начале текста, иначе первая содержательная строка,
    иначе имя файла без расширения."""
    if report.document_title and report.document_title.strip():
        return report.document_title.strip()
    lines = [ln.strip() for ln in report.document.text.splitlines()[:60]]
    for ln in lines:
        if re.match(r"^#{1,2}\s+\S", ln):
            s = _plain(ln.lstrip("#").strip()).strip()
            if 3 <= len(s) <= 180:
                return s
    for ln in lines:
        s = _plain(ln.strip("#*_| ")).strip()
        if not s or set(s) <= set("-=_ "):
            continue
        if 8 <= len(s) <= 160 and not s.replace(".", "").isdigit():
            return s
        break
    return Path(report.passport.document_name).stem or report.passport.document_name


def _clean_requirements(report: Report) -> list[str]:
    hit = {rid for f in report.findings for rid in f.requirement_ids}
    return [r.id for r in report.requirements if r.id not in hit]


def _split_fix(text: str) -> tuple[str, str]:
    """«D-002: Устранить…» → («Устранить…», «D-002»); ссылки в начале выносятся в конец пункта."""
    s = _one_line(text)
    m = re.match(r"^((?:[DQR]-\d+(?:\.\d+)?[\s,;и]*)+)\s*[:.—–-]\s*(.+)$", s)
    if m:
        refs = ", ".join(_REF.findall(m.group(1)))
        return m.group(2).strip(), refs
    return s, ""


# ---------------------------------------------------------------- документ


class _Pdf(FPDF):
    def __init__(self, report: Report, total_pages: int | None):
        super().__init__(format="A4", unit="mm")
        self.report = report
        self.total_pages = total_pages
        regular, bold = _find_font()
        self.add_font("DejaVu", "", regular)
        self.add_font("DejaVu", "B", bold)
        self.add_font("DejaVu", "I", regular)
        self.add_font("DejaVu", "BI", bold)
        font_dir = Path(regular).parent
        mono, mono_b = font_dir / "DejaVuSansMono.ttf", font_dir / "DejaVuSansMono-Bold.ttf"
        if mono.is_file():
            self.add_font("DejaVuMono", "", str(mono))
            self.add_font("DejaVuMono", "B", str(mono_b if mono_b.is_file() else mono))
            self.mono = "DejaVuMono"
        else:
            self.mono = "DejaVu"
        self.set_margins(MARGIN_X, MARGIN_TOP, MARGIN_X)
        self.set_auto_page_break(True, MARGIN_BOTTOM)
        self.set_title(f"Отчёт о проверке требований: {report.passport.document_name}")
        self.set_author("Zoe")
        self.set_creator(f"Zoe {report.passport.agent_version}")
        self.set_lang("ru")

    # -- примитивы

    def font(self, size: float, style: str = "", color: RGB = INK, mono: bool = False) -> None:
        self.set_font(self.mono if mono else "DejaVu", style if not mono else style.replace("I", ""), size)
        self.set_text_color(*color)

    def hline(self, y: float, color: RGB = HAIR, width: float = 0.2, x1: float | None = None,
              x2: float | None = None) -> None:
        self.set_draw_color(*color)
        self.set_line_width(width)
        self.line(self.l_margin if x1 is None else x1, y, self.w - self.r_margin if x2 is None else x2, y)

    def fit(self, text: str, width: float) -> str:
        if self.get_string_width(text) <= width:
            return text
        while text and self.get_string_width(text + "…") > width:
            text = text[:-1]
        return text.rstrip() + "…"

    def lines(self, text: str, width: float, lh: float) -> int:
        return len(self.multi_cell(width, lh, text, dry_run=True, output="LINES"))

    @property
    def page_label(self) -> str:
        total = self.total_pages if self.total_pages else "…"
        return f"стр. {self.page_no()} из {total}"

    # -- колонтитулы

    def header(self) -> None:
        if self.page_no() == 1:
            return
        p = self.report.passport
        self.set_xy(self.l_margin, 9)
        self.font(7.5, "B")
        self.cell(self.get_string_width("Zoe") + 1, 4, "Zoe")
        self.font(7.5, color=MUTED)
        self.cell(0, 4, " · Отчёт о проверке требований")
        self.set_xy(self.l_margin, 9)
        self.font(7.5, color=MUTED, mono=True)
        self.cell(self.epw, 4, self.fit(p.document_name, self.epw * 0.5), align="R")
        self.hline(14.2)
        self.set_xy(self.l_margin, self.t_margin)

    def footer(self) -> None:
        p = self.report.passport
        y = self.h - 13
        self.hline(y, RULE if self.page_no() == 1 else HAIR)
        self.set_xy(self.l_margin, y + 1.6)
        self.font(7.5, color=MUTED, mono=True)
        left = (f"Проверено {p.run_at.strftime('%d.%m.%Y %H:%M')} UTC · {p.model} · агент {p.agent_version}")
        self.cell(self.epw * 0.75, 4, self.fit(left, self.epw * 0.75))
        self.set_xy(self.l_margin, y + 1.6)
        self.cell(self.epw, 4, self.page_label, align="R")


# ---------------------------------------------------------------- титульная страница


def _verdict(report: Report) -> tuple[str, str, RGB, RGB, RGB]:
    c = report.conclusion
    if c.decision == Decision.LIMITED:
        sev = Severity.MINOR
        return "!", "Можно с ограничениями — по части требований", SEV_COLOR[sev], SEV_TINT[sev], SEV_DARK[sev]
    if c.decision == Decision.BLOCKED:
        sev = Severity.CRITICAL
        return "✕", "Не готово к разработке и тестированию", SEV_COLOR[sev], SEV_TINT[sev], SEV_DARK[sev]
    if c.ready_for_development and c.ready_for_testing:
        return "✓", "Готово к разработке и тестированию", GOOD, GOOD_TINT, GOOD_DARK
    if not c.ready_for_development and not c.ready_for_testing:
        sev = Severity.CRITICAL
        title = "Не готово к разработке и тестированию"
    else:
        sev = Severity.MINOR
        title = ("Готово к разработке, не готово к тестированию" if c.ready_for_development
                 else "Готово к тестированию, не готово к разработке")
    return ("✕" if sev == Severity.CRITICAL else "!"), title, SEV_COLOR[sev], SEV_TINT[sev], SEV_DARK[sev]


# Знак Zoe (тот же, что в вебе): пять кругов в поле 100×100, два верхних левых соединены перемычкой.
_LOGO_CIRCLES = ((24, 22, 18), (52, 50, 15), (83, 19, 14), (21, 80, 15), (84, 83, 9))
_LOGO_NECK = ((23.06, 39.98), (33.86, 42.26), (37.02, 50.79), (52.79, 35.02), (44.26, 31.86), (41.98, 21.06))


def _logo(pdf: _Pdf, x: float, y: float, size: float) -> None:
    """Белый знак на чёрной плашке со скруглёнными углами, сторона size мм."""
    pdf.set_fill_color(0, 0, 0)
    pdf.rect(x, y, size, size, style="F", round_corners=True, corner_radius=size * 0.22)
    pad = size * 0.16
    k = (size - 2 * pad) / 100
    ox, oy = x + pad, y + pad
    pt = lambda px, py: (ox + px * k, oy + py * k)  # noqa: E731
    pdf.set_fill_color(255, 255, 255)
    for cx, cy, r in _LOGO_CIRCLES:
        pdf.polygon([pt(cx + r * math.cos(a), cy + r * math.sin(a)) for a in (i * math.tau / 40 for i in range(40))],
                    style="F")
    p1, c1, q1, q2, c2, p2 = _LOGO_NECK

    def quad(a: tuple, c: tuple, b: tuple) -> list:
        return [pt((1 - t) ** 2 * a[0] + 2 * (1 - t) * t * c[0] + t * t * b[0],
                   (1 - t) ** 2 * a[1] + 2 * (1 - t) * t * c[1] + t * t * b[1]) for t in (i / 12 for i in range(13))]

    pdf.polygon(quad(p1, c1, q1) + quad(q2, c2, p2), style="F")


def _cover(pdf: _Pdf, toc: list[tuple[str, str]], pages: dict[str, int]) -> None:
    r = pdf.report
    p, s, c = r.passport, r.summary, r.conclusion
    L, W = pdf.l_margin, pdf.epw
    pdf.add_page()

    # бренд и стандарты
    y = 15.0
    _logo(pdf, L, y - 0.2, 5.6)
    pdf.set_xy(L + 7.4, y)
    pdf.font(12.5, "B")
    pdf.cell(40, 5.2, "Zoe")
    pdf.set_xy(L, y + 0.4)
    pdf.font(8.5, color=MUTED, mono=True)
    pdf.cell(W, 4.5, "ISO/IEC/IEEE 29148 · IEEE 830", align="R")
    y += 8.8
    pdf.hline(y, INK, 0.55)

    # название и паспорт
    y += 6.5
    pdf.set_xy(L, y)
    pdf.font(8.5, color=MUTED, mono=True)
    pdf.set_char_spacing(0.7)
    pdf.cell(W, 4, "ОТЧЁТ О ПРОВЕРКЕ ТРЕБОВАНИЙ")
    pdf.set_char_spacing(0)
    y += 6
    title = document_title(r)
    size = 22.0
    pdf.font(size, "B")
    while size > 15 and pdf.lines(title, W, size * 0.43) > 2:
        size -= 1.5
        pdf.font(size, "B")
    pdf.set_xy(L, y)
    lh = size * 0.43
    if pdf.lines(title, W, lh) > 3:
        title = _short(title, 150)
    pdf.multi_cell(W, lh, title, align="L", new_x="LMARGIN", new_y="NEXT")
    y = pdf.get_y() + 1.8
    pdf.set_xy(L, y)
    pdf.font(10.5, color=INK2)
    meta = (f"{p.document_name} · проверено {p.run_at.strftime('%d.%m.%Y')} · модель {p.model} · "
            f"агент {p.agent_version}")
    pdf.multi_cell(W, 5.2, meta, align="L", new_x="LMARGIN", new_y="NEXT")

    # вердикт
    y = pdf.get_y() + 5.5
    icon, vtitle, color, tint, dark = _verdict(r)
    pad, icon_w = 4.6, 13.6
    tx = L + pad + icon_w + 4.2
    tw = L + W - pad - tx
    rationale = _short(c.rationale, 330) or "Обоснование не указано."
    pdf.font(10.5)
    n_rat = pdf.lines(rationale, tw, 5.2)
    pdf.font(14.5, "B")
    n_title = pdf.lines(vtitle, tw, 7.0)
    status = (f"Разработка: {'да' if c.ready_for_development else 'нет'}   ·   "
              f"Тестирование: {'да' if c.ready_for_testing else 'нет'}")
    box_h = pad + n_title * 7.0 + 1.4 + 5.0 + n_rat * 5.2 + pad - 0.6
    box_h = max(box_h, icon_w + 2 * pad)
    pdf.set_fill_color(*tint)
    pdf.set_draw_color(*color)
    pdf.set_line_width(0.55)
    pdf.rect(L, y, W, box_h, style="DF")
    pdf.set_line_width(0.5)
    pdf.rect(L + pad, y + pad, icon_w, icon_w, style="D")
    pdf.set_xy(L + pad, y + pad)
    pdf.font(19, "B", color)
    pdf.cell(icon_w, icon_w, icon, align="C")
    pdf.set_xy(tx, y + pad - 0.4)
    pdf.font(14.5, "B", dark)
    pdf.multi_cell(tw, 7.0, vtitle, align="L", new_x="LEFT", new_y="NEXT")
    pdf.set_xy(tx, pdf.get_y() + 1.4)
    pdf.font(8.5, "B", color, mono=True)
    pdf.cell(tw, 4.6, status, new_x="LEFT", new_y="NEXT")
    pdf.set_xy(tx, pdf.get_y() + 0.6)
    pdf.font(10.5, color=INK)
    pdf.multi_cell(tw, 5.2, rationale, align="L")
    y += box_h + 5.5

    # ключевые показатели
    total = s.requirements_total
    clean = _clean_requirements(r)
    n_req = len(r.requirements) or total
    clean_pct = round(100 * len(clean) / n_req) if n_req else 0
    verified = sum(1 for f in r.findings if any(loc.verified for loc in f.locations))
    blockers = sum(1 for q in r.questions if q.priority == QuestionPriority.BLOCKER)
    sev = {k: s.by_severity.get(k, 0) for k in Severity}
    cells = [
        (str(total), "требований в документе", INK),
        (str(s.findings_total), "дефектов найдено", INK),
        (f"{clean_pct} %", f"требований без дефектов: {len(clean)} из {n_req}", INK),
        (f"{verified} из {s.findings_total}" if s.findings_total else "—", "дефектов подтверждены цитатой",
         INK),
        (str(sev[Severity.CRITICAL]), "критических", SEV_COLOR[Severity.CRITICAL]),
        (str(sev[Severity.MAJOR]), "существенных", SEV_COLOR[Severity.MAJOR]),
        (str(sev[Severity.MINOR]), "незначительных", SEV_COLOR[Severity.MINOR]),
        (str(len(r.questions)), f"вопросов автору, блокирующих: {blockers}" if blockers
         else "уточняющих вопросов автору", INK),
    ]
    cw, ch = W / 4, 18.5
    pdf.set_draw_color(*RULE)
    pdf.set_line_width(0.25)
    pdf.rect(L, y, W, ch * 2)
    for i in (1, 2, 3):
        pdf.line(L + cw * i, y, L + cw * i, y + ch * 2)
    pdf.line(L, y + ch, L + W, y + ch)
    for i, (num, cap, col) in enumerate(cells):
        cx, cy = L + cw * (i % 4), y + ch * (i // 4)
        if i >= 4 and i < 7:
            pdf.set_fill_color(*col)
            pdf.rect(cx + 3.6, cy + 3.4, 1.0, 6.2, style="F")
        pdf.set_xy(cx + (5.6 if 4 <= i < 7 else 3.6), cy + 2.6)
        pdf.font(17 if len(num) < 7 else 14.5, "B", col)
        pdf.cell(cw - 7, 8, num)
        pdf.set_xy(cx + 3.6, cy + 10.4)
        pdf.font(7.8, color=MUTED)
        pdf.multi_cell(cw - 6, 3.5, cap, align="L", max_line_height=3.5)
    y += ch * 2
    if s.findings_total:
        bx = L
        for k in Severity:
            if sev[k]:
                bw = W * sev[k] / max(sum(sev.values()), 1)
                pdf.set_fill_color(*SEV_COLOR[k])
                pdf.rect(bx, y + 1.4, bw, 1.6, style="F")
                bx += bw
    y += 8.5

    # содержание (внизу страницы) — считаем его место заранее
    toc_rows = (len(toc) + 1) // 2
    toc_h = 7.5 + toc_rows * 5.6
    toc_y = pdf.h - MARGIN_BOTTOM - toc_h - 1.5

    # что исправить первым
    if not c.top_fixes and not r.findings:
        pdf.set_xy(L, y)
        pdf.font(13, "B")
        pdf.cell(W, 6.5, "Дефектов не найдено", new_x="LMARGIN", new_y="NEXT")
        pdf.set_xy(L, pdf.get_y() + 1.5)
        pdf.font(10.5, color=INK2)
        pdf.multi_cell(W, 5.3, "Ни одно требование не нарушает критерии ISO/IEC/IEEE 29148 и IEEE 830, "
                       "проверенные агентом. Подробности по каждому требованию — в разделе 3.", align="L")
        y = pdf.get_y() + 4.5
    if c.top_fixes:
        pdf.set_xy(L, y)
        pdf.font(13, "B")
        pdf.cell(W, 6.5, "Что исправить первым", new_x="LMARGIN", new_y="NEXT")
        y = pdf.get_y() + 1.5
        for i, fix in enumerate(c.top_fixes[:5], 1):
            text, refs = _split_fix(fix)
            text = text[:1].upper() + text[1:]
            pdf.font(10.5)
            need = pdf.lines(text + (f" — {refs}" if refs else ""), W - 7, 5.3) * 5.3
            if y + need > toc_y - 14:
                break
            pdf.set_xy(L, y)
            pdf.font(10.5, "B", ACCENT)
            pdf.cell(7, 5.3, f"{i}.")
            pdf.set_left_margin(L + 7)
            pdf.set_xy(L + 7, y)
            pdf.font(10.5, color=INK)
            pdf.write(5.3, text)
            if refs:
                pdf.font(10.5, color=MUTED)
                pdf.write(5.3, " — ")
                pdf.font(9.2, color=MUTED, mono=True)
                pdf.write(5.3, refs)
            pdf.set_left_margin(L)
            pdf.ln(5.3)
            y = pdf.get_y() + 1.2
        y += 4.5

    # самые серьёзные дефекты
    fby = {f.id: f for f in r.findings}
    crit = [fby[i] for i in s.critical_finding_ids if i in fby] or \
        [f for f in r.findings if f.severity == Severity.CRITICAL]
    worst, label = crit, "Критические дефекты"
    if not worst:
        worst, label = [f for f in r.findings if f.severity == Severity.MAJOR], "Существенные дефекты"
    if worst and y + 22 >= toc_y and y + 8 < toc_y:
        pdf.set_xy(L, y)
        pdf.font(10.5, "B", SEV_COLOR[worst[0].severity])
        pdf.cell(W, 5.3, f"{label}: {len(worst)} — полный список в разделе «Сводка».")
    elif worst:
        pdf.set_xy(L, y)
        pdf.font(13, "B")
        pdf.cell(W, 6.5, label, new_x="LMARGIN", new_y="NEXT")
        y = pdf.get_y() + 1.5
        c_id, c_where = 17.0, 44.0
        c_title = W - c_id - c_where
        pdf.set_fill_color(*FILL)
        pdf.rect(L, y, W, 6.2, style="F")
        pdf.font(8.5, "B")
        for x, w, t in ((L, c_id, "ID"), (L + c_id, c_title, "Суть"), (L + c_id + c_title, c_where, "Место")):
            pdf.set_xy(x + 2, y + 1)
            pdf.cell(w - 4, 4.2, t)
        y += 6.2
        shown = 0
        for f in worst:
            where = _where_short(f)
            pdf.font(9.2)
            title = _short(f.title, 140)
            n = max(pdf.lines(title, c_title - 4, 4.3), pdf.lines(where, c_where - 4, 4.3))
            rh = n * 4.3 + 3
            if y + rh > toc_y - (11 if len(worst) - shown > 1 else 5):
                break
            pdf.set_xy(L + 2, y + 1.5)
            pdf.font(8.8, "B", SEV_COLOR[f.severity], mono=True)
            pdf.cell(c_id - 4, 4.3, f.id)
            pdf.set_xy(L + c_id + 2, y + 1.5)
            pdf.font(9.2)
            pdf.multi_cell(c_title - 4, 4.3, title, align="L")
            pdf.set_xy(L + c_id + c_title + 2, y + 1.5)
            pdf.font(8.6, color=MUTED)
            pdf.multi_cell(c_where - 4, 4.3, where, align="L")
            y += rh
            pdf.hline(y)
            shown += 1
        if shown < len(worst):
            pdf.set_xy(L, y + 1.5)
            pdf.font(8.6, color=MUTED)
            pdf.cell(W, 4.5, f"…и ещё {len(worst) - shown} — полный список в разделе «Сводка».")

    # содержание
    pdf.hline(toc_y, RULE, 0.25)
    pdf.set_xy(L, toc_y + 2.2)
    pdf.font(8.5, color=MUTED, mono=True)
    pdf.set_char_spacing(0.7)
    pdf.cell(W, 4, "СОДЕРЖАНИЕ")
    pdf.set_char_spacing(0)
    col_w, gap = (W - 10) / 2, 10
    for i, (num, name) in enumerate(toc):
        col, row = divmod(i, toc_rows)
        x = L + col * (col_w + gap)
        ry = toc_y + 7.5 + row * 5.6
        page = pages.get(f"{num}. {name}")
        link = pdf.add_link(page=page) if page else None
        pdf.set_xy(x, ry)
        pdf.font(9.5, "B", ACCENT, mono=True)
        pdf.cell(6.5, 5, f"{num}.", link=link or "")
        pdf.font(9.5, color=INK)
        pnum = str(page) if page else ""
        name_w = col_w - 6.5 - 10
        pdf.cell(name_w, 5, pdf.fit(name, name_w), link=link or "")
        pdf.font(9.5, color=MUTED, mono=True)
        pdf.cell(10, 5, pnum, align="R", link=link or "")


def _where_short(f) -> str:
    pages = sorted({loc.page for loc in f.locations if loc.page})
    if pages:
        return "стр. " + ", ".join(map(str, pages))
    secs = []
    for loc in f.locations:
        sec = loc.section.split("›")[-1].strip()
        if sec and sec not in secs:
            secs.append(sec)
    return _short("; ".join(secs), 60) or "—"


# ---------------------------------------------------------------- тело отчёта


def _write_inline(pdf: _Pdf, text: str, size: float = BODY_PT, lh: float = BODY_LH,
                  color: RGB = INK) -> None:
    for st, t in _inline_segments(text):
        if st == "B":
            pdf.font(size, "B", color)
        elif st == "I":
            pdf.font(size, color=MUTED)
        elif st == "C":
            pdf.font(size - 1, color=INK2, mono=True)
        else:
            pdf.font(size, color=color)
        pdf.write(lh, t)


def _hanging(pdf: _Pdf, marker: str, text: str, indent: float = 5.0, marker_color: RGB = MUTED,
             size: float = BODY_PT, lh: float = BODY_LH) -> None:
    L = pdf.l_margin
    if pdf.get_y() + lh > pdf.page_break_trigger:
        pdf.add_page()
    y = pdf.get_y()
    pdf.set_xy(L + 0.8, y)
    pdf.font(size, "B" if marker != "•" else "", marker_color)
    pdf.cell(indent - 0.8, lh, marker)
    pdf.set_left_margin(L + indent)
    pdf.set_xy(L + indent, y)
    try:
        _write_inline(pdf, text, size, lh)
    finally:
        pdf.set_left_margin(L)
    pdf.ln(lh + 0.9)


def _need(pdf: _Pdf, height: float) -> None:
    if pdf.get_y() + height > pdf.page_break_trigger:
        pdf.add_page()


def _col_widths(pdf: _Pdf, header: list[str], rows: list[list[str]], width: float) -> list[float]:
    pad = 4.8
    mins, wants = [], []
    for j in range(len(header)):
        texts = [_plain(r[j]) if j < len(r) else "" for r in rows]
        words = [w for t in texts for w in t.split()] or [""]
        longest = max(pdf.get_string_width(w) for w in words)
        widest = max([pdf.get_string_width(ln) for t in texts for ln in t.split("\n")] or [0.0])
        pdf.font(8, "B")  # заголовок столбца — жирный
        head = _plain(header[j])
        longest = max(longest, *(pdf.get_string_width(w) for w in head.split() or [""])) + pad
        widest = max(widest, pdf.get_string_width(head)) + pad
        pdf.font(8.2)
        lo = min(max(longest, 12.0), width * 0.34)
        mins.append(lo)
        wants.append(max(widest, lo))
    if sum(wants) <= width:
        return [w * width / sum(wants) for w in wants]
    extra = width - sum(mins)
    if extra <= 0:
        return [m * width / sum(mins) for m in mins]
    grow = [w - m for w, m in zip(wants, mins)]
    return [m + extra * g / (sum(grow) or 1) for m, g in zip(mins, grow)]


def _cell_style(text: str) -> FontFace | None:
    t = text.strip()
    if t.startswith("✘") or t == "Нет":
        return FontFace(color=SEV_COLOR[Severity.CRITICAL], emphasis="BOLD")
    if t.startswith("✔") or t == "Да":
        return FontFace(color=GOOD)
    if t.startswith("— неприменимо") or t == "Не требуется":
        return FontFace(color=MUTED)
    return None


def _table(pdf: _Pdf, header: list[str], rows: list[list[str]]) -> None:
    W = pdf.epw
    pdf.font(8.2)
    cols = _col_widths(pdf, header, rows, W)
    pdf.set_draw_color(*HAIR)
    pdf.set_line_width(0.2)
    pdf.set_fill_color(*WHITE)  # fpdf2 заливает ячейки текущим цветом заливки
    _need(pdf, 18)
    with pdf.table(col_widths=cols, width=W, line_height=3.9, text_align="LEFT", v_align="TOP",
                   borders_layout="HORIZONTAL_LINES", padding=(1.15, 1.8, 1.15, 1.8),
                   headings_style=FontFace(emphasis="BOLD", color=INK, fill_color=FILL, size_pt=8),
                   first_row_as_headings=True) as table:
        hr = table.row()
        for h in header:
            hr.cell(_plain(h))
        for r in rows:
            row = table.row()
            for j in range(len(header)):
                text = _plain(r[j]) if j < len(r) else ""
                row.cell(text, style=_cell_style(text))
    pdf.ln(3.5)


def _h2(pdf: _Pdf, text: str, pages: dict[str, int]) -> None:
    plain = _plain(text)
    pages[plain] = pdf.page_no()
    pdf.start_section(plain, level=0)
    m = re.match(r"^(\d+)\.\s+(.*)$", plain)
    num, title = (m.group(1) + ".", m.group(2)) if m else ("", plain)
    L, W = pdf.l_margin, pdf.epw
    y = pdf.get_y() + 1
    pdf.set_xy(L, y)
    pdf.font(16, "B", ACCENT)
    nw = pdf.get_string_width(num) + 2.5 if num else 0
    if num:
        pdf.cell(nw, 7.6, num)
    pdf.font(16, "B")
    pdf.set_xy(L + nw, y)
    pdf.multi_cell(W - nw, 7.6, title, align="L", new_x="LMARGIN", new_y="NEXT")
    y = pdf.get_y() + 1.6
    pdf.hline(y, INK, 0.5)
    pdf.set_xy(L, y + 4.5)


def _h3(pdf: _Pdf, text: str) -> None:
    plain = _plain(text)
    L, W = pdf.l_margin, pdf.epw
    m = re.match(r"^(R-[\d.]+)\s*(.*)$", plain)
    if not m:
        _need(pdf, 22)
        pdf.ln(2)
        pdf.set_x(L)
        pdf.font(11.5, "B")
        pdf.multi_cell(W, 5.8, plain, align="L", new_x="LMARGIN", new_y="NEXT")
        pdf.ln(1.8)
        return
    rid, rest = m.group(1), m.group(2).strip()
    pdf.start_section(f"{rid} — {_short(rest.lstrip('—– ').strip(), 60)}", level=1)
    src = re.match(r"^(\([^)]*\))\s*(.*)$", rest)
    tag = ""
    if src:
        tag, rest = src.group(1), src.group(2)
    part = re.match(r"^[—–]\s*(часть\s+R-[\d.]+)\s*(.*)$", rest)
    if part:
        tag, rest = (tag + " " + part.group(1)).strip(), part.group(2)
    rest = re.sub(r"^[—–]\s*", "", rest).strip()
    pdf.font(10.5, "B", mono=True)
    idw = pdf.get_string_width(rid) + 3
    pdf.font(8.5, color=MUTED, mono=True)
    tagw = pdf.get_string_width(tag) + 3 if tag else 0
    tw = W - 5 - idw - tagw
    pdf.font(10.5, "B")
    n = pdf.lines(rest or " ", tw, 5.2)
    h = n * 5.2 + 3.6
    _need(pdf, h + 26)
    pdf.ln(2.5)
    y = pdf.get_y()
    pdf.set_fill_color(*FILL)
    pdf.rect(L, y, W, h, style="F")
    pdf.set_fill_color(*ACCENT)
    pdf.rect(L, y, 1.0, h, style="F")
    pdf.set_xy(L + 3, y + 1.8)
    pdf.font(10.5, "B", INK, mono=True)
    pdf.cell(idw, 5.2, rid)
    if tag:
        pdf.font(8.5, color=MUTED, mono=True)
        pdf.cell(tagw, 5.2, tag)
    pdf.set_xy(L + 3 + idw + tagw, y + 1.8)
    pdf.font(10.5, "B")
    pdf.multi_cell(tw, 5.2, rest, align="L")
    pdf.set_xy(L, y + h + 2.6)


def _h4(pdf: _Pdf, text: str) -> None:
    plain = _plain(text)
    L = pdf.l_margin
    parts = plain.split(" · ", 2)
    _need(pdf, 24)
    pdf.ln(2)
    y = pdf.get_y()
    if len(parts) == 3 and parts[1] in _CHIP_COLOR:
        rid, level, rest = parts
        color = _CHIP_COLOR[level]
        pdf.font(7.2, "B", WHITE)
        label = level.upper()
        cw = pdf.get_string_width(label) + 3.6
        pdf.set_fill_color(*color)
        pdf.rect(L, y + 0.55, cw, 4.2, style="F")
        pdf.set_xy(L, y + 0.55)
        pdf.cell(cw, 4.2, label, align="C")
        pdf.set_xy(L + cw + 2, y)
        pdf.font(10, "B", color, mono=True)
        pdf.cell(pdf.get_string_width(rid) + 2.5, 5.3, rid)
        pdf.font(10, "B")
        pdf.write(5.3, rest)
    else:
        pdf.set_x(L)
        pdf.font(10, "B")
        pdf.write(5.3, plain)
    pdf.ln(5.3 + 1.4)


def _block(pdf: _Pdf, b: tuple, pages: dict[str, int], intro: bool) -> None:
    kind = b[0]
    if kind == "heading":
        level, text = b[1], b[2]
        if level <= 2:
            _h2(pdf, text, pages)
        elif level == 3:
            _h3(pdf, text)
        else:
            _h4(pdf, text)
    elif kind == "table":
        _table(pdf, b[1], b[2])
    elif kind == "bullet":
        _hanging(pdf, "•", b[1])
    elif kind == "number":
        m = re.match(r"^(\d+\.)\s+(.*)$", b[1])
        _hanging(pdf, m.group(1), m.group(2), indent=6.5, marker_color=ACCENT)
    elif kind == "para":
        text = b[1]
        segs = _inline_segments(text)
        pdf.set_x(pdf.l_margin)
        if intro:  # вводный абзац перед паспортом
            _write_inline(pdf, text, 10, 5.3, INK2)
            pdf.ln(5.3 + 4)
        elif len(segs) == 1 and segs[0][0] == "I":  # примечание о методике
            _need(pdf, 12)
            _write_inline(pdf, text, 8, 4.1, MUTED)
            pdf.ln(4.1 + 1.5)
        else:
            _write_inline(pdf, text)
            pdf.ln(BODY_LH + 1.6)
    elif kind == "rule":
        pdf.ln(2)
        pdf.hline(pdf.get_y())
        pdf.ln(3)


def _body(pdf: _Pdf, md: str, pages: dict[str, int]) -> None:
    blocks = list(_blocks(md))
    if blocks and blocks[0][0] == "heading" and blocks[0][1] == 1:
        blocks = blocks[1:]  # название документа — на титуле
    pdf.add_page()
    seen_h2 = False
    for i, b in enumerate(blocks):
        if b[0] == "heading" and b[1] <= 2:
            if seen_h2:
                if _plain(b[2]).rstrip().endswith("Итог"):
                    # короткий «Итог» с примечанием — на той же странице, если целиком помещается
                    pdf.ln(6)
                    with pdf.offset_rendering() as dummy:
                        for t in blocks[i:]:
                            _block(dummy, t, {}, False)
                    if dummy.page_break_triggered:
                        pdf.add_page()
                else:
                    pdf.add_page()
            seen_h2 = True
        _block(pdf, b, pages, intro=not seen_h2)


# ---------------------------------------------------------------- вход


def _toc(md: str) -> list[tuple[str, str]]:
    out = []
    for b in _blocks(md):
        if b[0] == "heading" and b[1] == 2:
            m = re.match(r"^(\d+)\.\s+(.*)$", _plain(b[2]))
            if m:
                out.append((m.group(1), m.group(2)))
    return out


def _build(report: Report, md: str, pages: dict[str, int], total: int | None) -> tuple[_Pdf, dict[str, int]]:
    pdf = _Pdf(report, total)
    found: dict[str, int] = {}
    _cover(pdf, _toc(md), pages)
    _body(pdf, md, found)
    return pdf, found


def render_pdf_report(report: Report, md: str | None = None) -> bytes:
    md = md if md is not None else render_markdown(report)
    first, pages = _build(report, md, {}, None)
    total = first.page_no()
    final, _ = _build(report, md, pages, total)
    return bytes(final.output())


__all__ = ["document_title", "render_pdf_report"]
