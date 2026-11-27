// Календарные даты в виде строк YYYY-MM-DD (UTC, как у API /usage). Строки сравниваются лексикографически.

export const DAY_MS = 86_400_000

export const toIso = (ms: number) => new Date(ms).toISOString().slice(0, 10)
export const isoToMs = (iso: string) => Date.parse(`${iso}T00:00:00Z`)
export const todayIso = () => toIso(Date.now())
export const addDays = (iso: string, n: number) => toIso(isoToMs(iso) + n * DAY_MS)
/** Число дней в диапазоне, обе границы включительно. */
export const daysInclusive = (from: string, to: string) => Math.round((isoToMs(to) - isoToMs(from)) / DAY_MS) + 1
export const monthStart = (iso: string) => `${iso.slice(0, 8)}01`

export function addMonths(iso: string, n: number) {
  const d = new Date(isoToMs(iso))
  return toIso(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1))
}

export function daysOfRange(from: string, to: string): string[] {
  const out: string[] = []
  for (let t = isoToMs(from), end = isoToMs(to); t <= end; t += DAY_MS) out.push(toIso(t))
  return out
}

/** Клетки месяца для сетки «пн–вс»: пустые клетки до первого числа — null. */
export function monthCells(monthIso: string): (string | null)[] {
  const first = isoToMs(monthStart(monthIso))
  const lead = (new Date(first).getUTCDay() + 6) % 7
  const days = daysOfRange(toIso(first), addDays(addMonths(monthIso, 1), -1))
  return [...Array<null>(lead).fill(null), ...days]
}

/** Колонка дня недели, понедельник = 0. */
export const weekdayIndex = (iso: string) => (new Date(isoToMs(iso)).getUTCDay() + 6) % 7

export function formatDmy(iso: string | null | undefined) {
  if (!iso) return ''
  const [y, m, d] = iso.split('-')
  return `${d}.${m}.${y}`
}

/** «дд.мм.гггг» → YYYY-MM-DD; несуществующая дата (31.02) — null. */
export function parseDmy(text: string): string | null {
  const m = /^\s*(\d{1,2})\.(\d{1,2})\.(\d{4})\s*$/.exec(text)
  if (!m) return null
  const [day, month, year] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const d = new Date(Date.UTC(year, month - 1, day))
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null
  return toIso(d.getTime())
}

/** Предыдущий период той же длины, вплотную перед текущим. */
export function previousRange(from: string, to: string) {
  const n = daysInclusive(from, to)
  return { from: addDays(from, -n), to: addDays(from, -1) }
}
