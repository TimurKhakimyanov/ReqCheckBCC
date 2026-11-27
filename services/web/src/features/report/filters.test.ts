import { describe, expect, it } from 'vitest'
import { sampleReport } from '@/mocks/data'
import { EMPTY_FILTERS, filterFindings, isFiltered } from './filters'

const all = sampleReport.findings

describe('filterFindings', () => {
  it('returns everything sorted by severity when no filters are set', () => {
    const out = filterFindings(all, {}, EMPTY_FILTERS)
    expect(out).toHaveLength(all.length)
    const rank = { critical: 0, major: 1, minor: 2 }
    expect(out.map((f) => rank[f.severity])).toEqual([...out.map((f) => rank[f.severity])].sort())
    expect(isFiltered(EMPTY_FILTERS)).toBe(false)
  })

  it('filters by severity, criterion, review status, requirement and text', () => {
    expect(filterFindings(all, {}, { ...EMPTY_FILTERS, severities: ['critical'] }).every((f) => f.severity === 'critical')).toBe(true)
    expect(filterFindings(all, {}, { ...EMPTY_FILTERS, criterion: 'set_consistent' }).map((f) => f.id)).toEqual(
      all.filter((f) => f.criterion === 'set_consistent').map((f) => f.id).sort(),
    )
    const reviews = { 'D-001': { finding_id: 'D-001', status: 'fixed' as const } }
    expect(filterFindings(all, reviews, { ...EMPTY_FILTERS, status: 'fixed' }).map((f) => f.id)).toEqual(['D-001'])
    expect(filterFindings(all, reviews, { ...EMPTY_FILTERS, status: 'open' })).toHaveLength(all.length - 1)
    expect(filterFindings(all, {}, { ...EMPTY_FILTERS, requirement: 'R-002' }).every((f) => f.requirement_ids?.includes('R-002'))).toBe(true)
    const q = all[0].locations[0].quote.slice(0, 12)
    expect(filterFindings(all, {}, { ...EMPTY_FILTERS, q }).map((f) => f.id)).toContain(all[0].id)
  })
})
