import { describe, expect, it } from 'vitest'
import { presetRange } from '@/components/ui/date-range-picker'
import { addMonths, daysInclusive, formatDmy, monthCells, parseDmy, previousRange, weekdayIndex } from './dates'

describe('dates', () => {
  it('month grid starts on Monday with blanks before the 1st', () => {
    // 1 ноября 2026 — воскресенье: шесть пустых клеток (пн–сб)
    const cells = monthCells('2026-11-14')
    expect(cells.slice(0, 7)).toEqual([null, null, null, null, null, null, '2026-11-01'])
    expect(cells.at(-1)).toBe('2026-11-30')
    expect(cells.filter(Boolean)).toHaveLength(30)
    expect(weekdayIndex('2026-11-30')).toBe(0)
  })

  it('parses and formats dd.mm.yyyy, rejecting impossible dates', () => {
    expect(parseDmy('7.3.2026')).toBe('2026-03-07')
    expect(parseDmy(' 29.02.2024 ')).toBe('2024-02-29')
    expect(parseDmy('29.02.2026')).toBeNull()
    expect(parseDmy('2026-03-07')).toBeNull()
    expect(formatDmy('2026-03-07')).toBe('07.03.2026')
  })

  it('counts days inclusively and finds the previous period of the same length', () => {
    expect(daysInclusive('2026-11-14', '2026-11-27')).toBe(14)
    expect(previousRange('2026-11-14', '2026-11-27')).toEqual({ from: '2026-10-31', to: '2026-11-13' })
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-01')
  })

  it('presets are relative to the given day', () => {
    expect(presetRange('last7', '2026-11-27')).toEqual({ from: '2026-11-21', to: '2026-11-27' })
    expect(presetRange('lastMonth', '2026-03-10')).toEqual({ from: '2026-02-01', to: '2026-02-28' })
    expect(presetRange('ytd', '2026-11-27')).toEqual({ from: '2026-01-01', to: '2026-11-27' })
  })
})
