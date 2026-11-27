"""Замер полноты отчёта по эталону дефектов (для живого прогона; в промптах эталон не используется).

    python eval/recall.py report.json eval/requirements_md_reference.json

Эталонный дефект считается найденным, если хотя бы одно место дефекта в отчёте пересекается
хотя бы с одной цитатой эталона (цитаты эталона ищутся в тексте документа тем же QuoteLocator).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from req_contracts import Report

from req_core.text import QuoteLocator


def recall(report: Report, reference: dict) -> tuple[float, list[tuple[str, str, list[str]]]]:
    loc = QuoteLocator(report.document.text)
    spans = [(f.id, (l.char_start, l.char_end)) for f in report.findings for l in f.locations
             if l.verified and l.char_start is not None]
    rows = []
    for d in reference["defects"]:
        refs = [m for q in d["quotes"] if (m := loc.locate(q))]
        hits = sorted({fid for fid, (s, e) in spans for m in refs if min(e, m.end) > max(s, m.start)})
        rows.append((d["id"], d["title"], hits))
    found = sum(1 for _, _, h in rows if h)
    return found / max(1, len(rows)), rows


def main(argv: list[str]) -> int:
    report = Report.model_validate_json(Path(argv[1]).read_text(encoding="utf-8"))
    reference = json.loads(Path(argv[2]).read_text(encoding="utf-8"))
    r, rows = recall(report, reference)
    for rid, title, hits in rows:
        print(f"{'✔' if hits else '✘'} {rid} {title} {('→ ' + ', '.join(hits)) if hits else ''}")
    print(f"\nПолнота: {r:.0%} ({sum(1 for *_, h in rows if h)}/{len(rows)}); "
          f"дефектов в отчёте: {len(report.findings)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
