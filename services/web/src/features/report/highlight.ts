// Разметка текста документа под подсветку цитат дефектов по SourceLocation.char_start / char_end.
// Смещения ядро считает в символах Python (code points); JS-строки — UTF-16, поэтому смещения переводятся.
import type { Finding, Severity } from '@/api/types'
import { SEVERITY_RANK } from '@/shared/criteria'

/** Перевод смещения в code points (Python) в индекс UTF-16 (JS). Для текста без суррогатных пар — тождество. */
export function makeOffsetMapper(text: string): (cp: number) => number {
  if (!/[\uD800-\uDBFF]/.test(text)) return (cp) => cp
  const map: number[] = []
  let u = 0
  for (const ch of text) {
    map.push(u)
    u += ch.length
  }
  map.push(u)
  return (cp) => map[Math.max(0, Math.min(cp, map.length - 1))]
}

export interface Range {
  start: number
  end: number
  findingId: string
  locIndex: number
  severity: Severity
}

export interface Segment {
  start: number
  end: number
  text: string
  /** Дефекты, чьи цитаты покрывают этот фрагмент (в порядке severity, затем id). */
  ranges: Range[]
}

/**
 * Диапазоны цитат. Если смещений нет или они не совпадают с цитатой, ищем цитату в тексте
 * (на случай непроверенных SourceLocation) — иначе место не подсвечивается.
 */
export function collectRanges(text: string, findings: Finding[]): Range[] {
  const toUtf16 = makeOffsetMapper(text)
  const out: Range[] = []
  for (const f of findings) {
    f.locations.forEach((loc, locIndex) => {
      let start: number | null = null
      let end: number | null = null
      if (loc.char_start != null && loc.char_end != null && loc.char_end > loc.char_start) {
        start = toUtf16(loc.char_start)
        end = toUtf16(loc.char_end)
        if (end > text.length || (loc.quote && text.slice(start, end) !== loc.quote && text.indexOf(loc.quote) >= 0)) {
          start = null
        }
      }
      if (start === null && loc.quote) {
        const i = text.indexOf(loc.quote)
        if (i >= 0) {
          start = i
          end = i + loc.quote.length
        }
      }
      if (start !== null && end !== null && end > start) out.push({ start, end, findingId: f.id, locIndex, severity: f.severity })
    })
  }
  return out
}

/** Разбивает текст на сегменты по всем границам диапазонов; пересекающиеся цитаты дают общий сегмент. */
export function buildSegments(text: string, ranges: Range[]): Segment[] {
  if (!ranges.length) return [{ start: 0, end: text.length, text, ranges: [] }]
  const bounds = new Set<number>([0, text.length])
  for (const r of ranges) {
    bounds.add(Math.max(0, r.start))
    bounds.add(Math.min(text.length, r.end))
  }
  const points = [...bounds].sort((a, b) => a - b)
  const segs: Segment[] = []
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i]
    const end = points[i + 1]
    if (end <= start) continue
    const covering = ranges
      .filter((r) => r.start <= start && r.end >= end)
      .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.findingId.localeCompare(b.findingId))
    const prev = segs[segs.length - 1]
    // склеиваем соседние сегменты без подсветки
    if (!covering.length && prev && !prev.ranges.length) {
      prev.end = end
      prev.text = text.slice(prev.start, end)
      continue
    }
    segs.push({ start, end, text: text.slice(start, end), ranges: covering })
  }
  return segs
}

export function topSeverity(ranges: Range[]): Severity | null {
  return ranges.length ? ranges[0].severity : null
}
