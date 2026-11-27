import { describe, expect, it } from 'vitest'
import { fillDays, niceMax, pctChange, usageCsv } from './usage'

describe('usage helpers', () => {
  it('fills days without runs with zeros so the axis is continuous', () => {
    const days = fillDays([{ date: '2026-11-02', runs: 2, llm_calls: 14, prompt_tokens: 100, completion_tokens: 20, cost_usd: 0.01 }], '2026-11-01', '2026-11-03')
    expect(days.map((d) => d.date)).toEqual(['2026-11-01', '2026-11-02', '2026-11-03'])
    expect(days[0].runs).toBe(0)
    expect(days[1].runs).toBe(2)
  })

  it('rounds the scale up to a value with even quarters', () => {
    expect(niceMax(141_400)).toBe(160_000)
    expect(niceMax(0.0805)).toBeCloseTo(0.1)
    expect(niceMax(0)).toBe(1)
  })

  it('percent change is null when there is nothing to compare with', () => {
    expect(pctChange(110, 100)).toBeCloseTo(10)
    expect(pctChange(5, 0)).toBeNull()
    expect(pctChange(5, undefined)).toBeNull()
  })

  it('exports one CSV line per day', () => {
    const csv = usageCsv(fillDays([], '2026-11-01', '2026-11-02'))
    expect(csv.trim().split('\n')).toEqual([
      'date,runs,llm_calls,prompt_tokens,completion_tokens,cost_usd,duration_s',
      '2026-11-01,0,0,0,0,0,0',
      '2026-11-02,0,0,0,0,0,0',
    ])
  })
})
