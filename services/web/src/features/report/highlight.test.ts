import { describe, expect, it } from 'vitest'
import type { Finding } from '@/api/types'
import { sampleReport } from '@/mocks/data'
import { buildSegments, collectRanges, makeOffsetMapper } from './highlight'

const finding = (id: string, severity: Finding['severity'], locs: [number | null, number | null, string][]): Finding =>
  ({
    id,
    scope: 'requirement',
    criterion: 'unambiguous',
    severity,
    title: id,
    explanation: '',
    locations: locs.map(([s, e, quote]) => ({ section: 's', quote, char_start: s, char_end: e, verified: true })),
  }) as unknown as Finding

describe('highlight by char offsets', () => {
  it('every quote of the sample report lands exactly on its text', () => {
    const { text } = sampleReport.document
    const ranges = collectRanges(text, sampleReport.findings)
    const total = sampleReport.findings.reduce((n, f) => n + f.locations.length, 0)
    expect(ranges).toHaveLength(total)
    for (const r of ranges) {
      const loc = sampleReport.findings.find((f) => f.id === r.findingId)!.locations[r.locIndex]
      expect(text.slice(r.start, r.end)).toBe(loc.quote)
    }
  })

  it('segments reassemble the original text', () => {
    const { text } = sampleReport.document
    const segs = buildSegments(text, collectRanges(text, sampleReport.findings))
    expect(segs.map((s) => s.text).join('')).toBe(text)
    expect(segs.filter((s) => s.ranges.length).length).toBeGreaterThan(0)
  })

  it('splits overlapping quotes into shared segments ordered by severity', () => {
    const text = 'abcdefghij'
    const f1 = finding('D-001', 'minor', [[2, 6, 'cdef']])
    const f2 = finding('D-002', 'critical', [[4, 8, 'efgh']])
    const segs = buildSegments(text, collectRanges(text, [f1, f2]))
    expect(segs.map((s) => [s.text, s.ranges.map((r) => r.findingId)])).toEqual([
      ['ab', []],
      ['cd', ['D-001']],
      ['ef', ['D-002', 'D-001']],
      ['gh', ['D-002']],
      ['ij', []],
    ])
  })

  it('converts Python code-point offsets to UTF-16 when the text has astral characters', () => {
    const text = '😀 Система должна 🚀 отвечать быстро'
    const quote = 'отвечать быстро'
    const cps = [...text]
    // смещение, как его посчитает Python: в code points
    const start = cps.findIndex((_, i) => cps.slice(i, i + quote.length).join('') === quote)
    expect(start).toBe(text.indexOf(quote) - 2) // два эмодзи = по 2 единицы UTF-16
    const ranges = collectRanges(text, [finding('D-001', 'major', [[start, start + quote.length, quote]])])
    expect(text.slice(ranges[0].start, ranges[0].end)).toBe(quote)
    const map = makeOffsetMapper(text)
    expect(map(1)).toBe(2)
  })

  it('falls back to searching the quote when offsets are missing or wrong', () => {
    const text = 'Первое. Второе требование. Третье.'
    const ranges = collectRanges(text, [
      finding('D-001', 'major', [[null, null, 'Второе требование']]),
      finding('D-002', 'minor', [[0, 5, 'Третье']]),
      finding('D-003', 'minor', [[null, null, 'нет в тексте']]),
    ])
    expect(ranges.map((r) => [r.findingId, text.slice(r.start, r.end)])).toEqual([
      ['D-001', 'Второе требование'],
      ['D-002', 'Третье'],
    ])
  })
})
