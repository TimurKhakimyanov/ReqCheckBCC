// Расчёты для дэшборда расхода: сплошная ось дней, «круглая» шкала, изменение к прошлому периоду, CSV.
import type { UsageByDay, UsageRow } from '@/api/types'
import { daysOfRange } from '@/shared/dates'

export type UsageMetric = 'tokens' | 'cost' | 'runs'

export const tokensOf = (r: UsageRow) => (r.prompt_tokens ?? 0) + (r.completion_tokens ?? 0)

export function metricValue(r: UsageRow, metric: UsageMetric) {
  if (metric === 'tokens') return tokensOf(r)
  if (metric === 'cost') return r.cost_usd ?? 0
  return r.runs ?? 0
}

const emptyDay = (date: string): UsageByDay => ({
  date,
  runs: 0,
  llm_calls: 0,
  prompt_tokens: 0,
  completion_tokens: 0,
  cost_usd: 0,
  duration_s: 0,
})

/** API отдаёт только дни, в которые были прогоны, — дополняем период нулями, чтобы ось дней была сплошной. */
export function fillDays(rows: UsageByDay[], from: string, to: string): UsageByDay[] {
  const byDate = new Map(rows.map((r) => [r.date, r]))
  return daysOfRange(from, to).map((d) => byDate.get(d) ?? emptyDay(d))
}

/** Верх шкалы: ближайшее «круглое» число, делящееся на 4 ровными шагами. */
export function niceMax(v: number) {
  if (!(v > 0)) return 1
  const e = 10 ** Math.floor(Math.log10(v))
  const f = v / e
  const step = [1, 1.2, 1.6, 2, 4, 6, 8, 10].find((s) => f <= s + 1e-9) ?? 10
  return step * e
}

/** Изменение в процентах к прошлому периоду; null, если сравнивать не с чем. */
export function pctChange(current: number, previous: number | undefined | null) {
  if (!previous) return null
  return ((current - previous) / previous) * 100
}

export function usageCsv(days: UsageByDay[]) {
  const head = 'date,runs,llm_calls,prompt_tokens,completion_tokens,cost_usd,duration_s'
  const rows = days.map((d) =>
    [d.date, d.runs ?? 0, d.llm_calls ?? 0, d.prompt_tokens ?? 0, d.completion_tokens ?? 0, d.cost_usd ?? 0, d.duration_s ?? 0].join(','),
  )
  return [head, ...rows].join('\n') + '\n'
}

export function saveText(name: string, text: string, type = 'text/csv;charset=utf-8') {
  const href = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = href
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(href), 1000)
}
