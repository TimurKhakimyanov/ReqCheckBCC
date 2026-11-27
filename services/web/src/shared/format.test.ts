import { describe, expect, it } from 'vitest'
import { formatKk, formatKkRelative } from './format'

// Запасной казахский форматтер — для движков без данных ICU kk (там Intl пишет «2026 M11 27»).
describe('formatKk', () => {
  const d = new Date(Date.UTC(2026, 10, 27, 19, 6, 5)) // пятница
  const utc = { timeZone: 'UTC' } as const

  it('formats dates like CLDR kk', () => {
    expect(formatKk(d, { ...utc, dateStyle: 'medium', timeStyle: 'short' })).toBe('2026 ж. 27 қар., 19:06')
    expect(formatKk(d, { ...utc, dateStyle: 'medium', timeStyle: 'medium' })).toBe('2026 ж. 27 қар., 19:06:05')
    expect(formatKk(d, { ...utc, day: 'numeric', month: 'long' })).toBe('27 қараша')
    expect(formatKk(d, { ...utc, day: 'numeric', month: 'short' })).toBe('27 қар.')
    expect(formatKk(d, { ...utc, day: 'numeric', month: 'long', year: 'numeric' })).toBe('2026 ж. 27 қараша')
    expect(formatKk(d, { ...utc, month: 'long' })).toBe('қараша')
    expect(formatKk(d, { ...utc, weekday: 'short' })).toBe('жм')
    expect(formatKk(d, { ...utc, weekday: 'short', day: 'numeric', month: 'long' })).toBe('27 қараша, жм')
  })

  it('formats relative time', () => {
    expect(formatKkRelative(-20, 'second')).toBe('жаңа ғана')
    expect(formatKkRelative(-5, 'minute')).toBe('5 минут бұрын')
    expect(formatKkRelative(-1, 'day')).toBe('кеше')
    expect(formatKkRelative(3, 'day')).toBe('3 күннен кейін')
  })
})
