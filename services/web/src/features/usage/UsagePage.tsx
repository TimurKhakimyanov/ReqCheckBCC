import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, BarChart3, ChevronsUpDown, Download } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { api } from '@/api/client'
import type { UsageByDay, UsageByProvider, UsageRow } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { DateRangePicker, presetRange, type DateRange } from '@/components/ui/date-range-picker'
import { EmptyState, ErrorNote, PageHeader, Skeleton, Table, TBody, TD, TH, THead, TR } from '@/components/ui/misc'
import { addDays, daysInclusive, previousRange, todayIso } from '@/shared/dates'
import { formatCompact, formatDay, formatNumber, formatUsd } from '@/shared/format'
import { cn } from '@/shared/utils'
import { DailyChart } from './DailyChart'
import { fillDays, metricValue, pctChange, saveText, tokensOf, usageCsv, type UsageMetric } from './usage'

const QUICK = [7, 14, 30, 90] as const
/** Цвета строк провайдеров: одинаковы в карточке долей и в таблице. */
const PALETTE = ['bg-primary', 'bg-accent-2', 'bg-teal', 'bg-sev-major', 'bg-sev-minor', 'bg-muted-foreground']

type SortKey = 'name' | 'runs' | 'llm_calls' | 'prompt_tokens' | 'completion_tokens' | 'cost_usd' | 'share'
type ProviderRow = UsageByProvider & { name: string; color: string; tokens: number; share: number }

export function UsagePage() {
  const { t } = useTranslation()
  const today = todayIso()
  const [range, setRange] = useState<DateRange>(() => presetRange('last14', today))
  const [metric, setMetric] = useState<UsageMetric>('tokens')
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'cost_usd', desc: true })

  const usage = useQuery({
    queryKey: ['usage', range.from, range.to],
    queryFn: () => api.usage(range),
    placeholderData: keepPreviousData,
  })
  const prevRange = previousRange(range.from, range.to)
  const prev = useQuery({
    queryKey: ['usage', prevRange.from, prevRange.to],
    queryFn: () => api.usage(prevRange),
    enabled: !!usage.data,
  })

  const u = usage.data
  const n = daysInclusive(range.from, range.to)
  const quickActive = range.to === today ? QUICK.find((q) => q === n) : undefined
  const days = useMemo(() => (u ? fillDays(u.by_day, range.from, range.to) : []), [u, range.from, range.to])

  const rows: ProviderRow[] = useMemo(() => {
    const list = u?.by_provider ?? []
    const byTokens = list.some((p) => tokensOf(p) > 0)
    const base = list.reduce((s, p) => s + (byTokens ? tokensOf(p) : (p.runs ?? 0)), 0) || 1
    return list.map((p, i) => ({
      ...p,
      name: t(`provider.${p.provider}`, { defaultValue: p.provider }),
      color: PALETTE[i % PALETTE.length],
      tokens: tokensOf(p),
      share: (byTokens ? tokensOf(p) : (p.runs ?? 0)) / base,
    }))
  }, [u, t])

  const sortedRows = useMemo(() => {
    const dir = sort.desc ? -1 : 1
    return [...rows].sort((a, b) =>
      sort.key === 'name' ? a.name.localeCompare(b.name) * dir : ((a[sort.key] ?? 0) - (b[sort.key] ?? 0)) * dir,
    )
  }, [rows, sort])

  const exportCsv = () => saveText(`reqcheck-usage_${range.from}_${range.to}.csv`, usageCsv(days))

  return (
    <>
      <PageHeader
        eyebrow={
          <span className="flex items-center gap-2">
            <span aria-hidden className="size-1.5 bg-primary" />
            {t('usage.eyebrow')}
          </span>
        }
        title={t('usage.title')}
        description={t('usage.subtitle')}
        actions={
          <div className="flex flex-wrap items-end gap-2">
            <Segmented
              label={t('usage.quickRange')}
              value={quickActive}
              options={QUICK.map((q) => ({ value: q, label: t('usage.daysShort', { count: q }) }))}
              onChange={(q) => setRange({ from: addDays(today, -(q - 1)), to: today })}
            />
            <div className="grid gap-1.5">
              <span id="usage-period" className="label-mono">
                {t('usage.period')}
              </span>
              <DateRangePicker aria-labelledby="usage-period" value={range} onChange={setRange} max={today} highlight={!quickActive} />
            </div>
            <Button variant="outline" onClick={exportCsv} disabled={!u || !u.totals.runs}>
              <Download />
              {t('usage.exportCsv')}
            </Button>
          </div>
        }
      />
      {usage.error && <ErrorNote error={usage.error} />}
      {!u ? (
        <div className="grid gap-3">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-36 rounded-2xl" />
            ))}
          </div>
          <Skeleton className="h-96 rounded-2xl" />
        </div>
      ) : (
        <div aria-busy={usage.isFetching} className={cn('grid gap-3 transition-opacity', usage.isPlaceholderData && 'opacity-60')}>
          <Kpis totals={u.totals} prevTotals={prev.data?.totals} days={n} costSpark={days.map((d) => d.cost_usd ?? 0)} />

          <div className="flex flex-wrap gap-3">
            <Card className="min-w-0 flex-[999_1_600px] px-5 pt-5 pb-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="font-medium tracking-tight">{t('usage.byDay')}</h2>
                  {!!u.totals.runs && <p className="mt-1 text-[13px] text-muted-foreground">{chartSummary(days, metric, t)}</p>}
                </div>
                <Segmented
                  label={t('usage.metric')}
                  value={metric}
                  options={[
                    { value: 'tokens', label: t('usage.metricTokens') },
                    { value: 'cost', label: t('usage.cost') },
                    { value: 'runs', label: t('usage.metricRuns') },
                  ]}
                  onChange={setMetric}
                />
              </div>
              {u.totals.runs ? (
                <>
                  <div className="mt-3.5 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
                    {metric === 'tokens' && (
                      <>
                        <Legend swatch="bg-primary" label={t('usage.promptTokens')} />
                        <Legend swatch="bg-primary/40" label={t('usage.completionTokens')} />
                      </>
                    )}
                    {metric === 'cost' && <Legend swatch="bg-primary" label={t('usage.costUsd')} />}
                    {metric === 'runs' && <Legend swatch="bg-accent-2" label={t('usage.metricRuns')} />}
                  </div>
                  <DailyChart days={days} metric={metric} />
                </>
              ) : (
                <EmptyState icon={<BarChart3 />} title={t('usage.empty')} hint={t('usage.emptyHint')} />
              )}
            </Card>

            <Card className="flex min-w-0 flex-[1_1_300px] flex-col gap-4 p-5">
              <div>
                <h2 className="font-medium tracking-tight">{t('usage.providers')}</h2>
                <p className="mt-1 text-[13px] text-muted-foreground">{t('usage.providersHint')}</p>
              </div>
              {rows.length ? (
                <>
                  <div aria-hidden className="flex h-2.5 gap-[3px] overflow-hidden rounded-full">
                    {rows.map((r, i) => (
                      <span key={i} className={cn('h-full', r.color)} style={{ width: `${r.share * 100}%` }} />
                    ))}
                  </div>
                  <ul>
                    {rows.map((r, i) => (
                      <li key={i} className="grid grid-cols-[10px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-t py-3">
                        <span aria-hidden className={cn('size-2.5 rounded-[3px]', r.color)} />
                        <span className="truncate text-sm font-medium">{r.name}</span>
                        <span className="text-sm font-semibold tabular-nums">{formatShare(r.share)}</span>
                        <span />
                        <span className="truncate font-mono text-xs text-muted-foreground">{r.model ?? '—'}</span>
                        <span className="text-right text-xs text-muted-foreground tabular-nums">
                          {r.cost_usd ? formatUsd(r.cost_usd) : t('usage.free')}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {rows.some((r) => !r.cost_usd && r.tokens > 0) && (
                    <p className="mt-auto rounded-[10px] bg-secondary px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
                      {t('usage.freeNote')}
                    </p>
                  )}
                </>
              ) : (
                <p className="text-sm text-muted-foreground">{t('usage.empty')}</p>
              )}
            </Card>
          </div>

          {rows.length > 0 && (
            <Card className="overflow-hidden">
              <div className="px-5 pt-5 pb-3">
                <h2 className="font-medium tracking-tight">{t('usage.byProvider')}</h2>
                <p className="mt-1 text-[13px] text-muted-foreground">{t('usage.tableHint')}</p>
              </div>
              <Table className="min-w-[960px]">
                <THead>
                  <TR className="border-t">
                    <SortTh k="name" sort={sort} onSort={setSort} label={t('launch.provider')} />
                    <TH>{t('launch.model')}</TH>
                    <SortTh k="runs" sort={sort} onSort={setSort} label={t('usage.runs')} right />
                    <SortTh k="llm_calls" sort={sort} onSort={setSort} label={t('usage.calls')} right />
                    <SortTh k="prompt_tokens" sort={sort} onSort={setSort} label={t('usage.promptTokens')} right />
                    <SortTh k="completion_tokens" sort={sort} onSort={setSort} label={t('usage.completionTokens')} right />
                    <SortTh k="cost_usd" sort={sort} onSort={setSort} label={t('usage.cost')} right />
                    <SortTh k="share" sort={sort} onSort={setSort} label={t('usage.share')} />
                  </TR>
                </THead>
                <TBody>
                  {sortedRows.map((r, i) => (
                    <TR key={i}>
                      <TD className="py-3">
                        <span className="flex items-center gap-2.5 font-medium">
                          <span aria-hidden className={cn('size-2.5 shrink-0 rounded-[3px]', r.color)} />
                          {r.name}
                        </span>
                      </TD>
                      <TD className="py-3 font-mono text-xs text-muted-foreground">{r.model ?? '—'}</TD>
                      <TD className="py-3 text-right tabular-nums">{formatNumber(r.runs)}</TD>
                      <TD className="py-3 text-right tabular-nums">{formatNumber(r.llm_calls)}</TD>
                      <TD className="py-3 text-right tabular-nums">{formatNumber(r.prompt_tokens)}</TD>
                      <TD className="py-3 text-right tabular-nums">{formatNumber(r.completion_tokens)}</TD>
                      <TD className="py-3 text-right font-semibold tabular-nums">{formatUsd(r.cost_usd ?? 0)}</TD>
                      <TD className="py-3">
                        <span className="flex items-center gap-2.5">
                          <span aria-hidden className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary shadow-inset">
                            <span className={cn('block h-full rounded-full', r.color)} style={{ width: `${r.share * 100}%` }} />
                          </span>
                          <span className="w-10 text-right text-[13px] text-muted-foreground tabular-nums">{formatShare(r.share)}</span>
                        </span>
                      </TD>
                    </TR>
                  ))}
                </TBody>
                <tfoot>
                  <tr className="bg-secondary font-semibold">
                    <TD className="py-3">{t('usage.total')}</TD>
                    <TD className="py-3" />
                    <TD className="py-3 text-right tabular-nums">{formatNumber(u.totals.runs)}</TD>
                    <TD className="py-3 text-right tabular-nums">{formatNumber(u.totals.llm_calls)}</TD>
                    <TD className="py-3 text-right tabular-nums">{formatNumber(u.totals.prompt_tokens)}</TD>
                    <TD className="py-3 text-right tabular-nums">{formatNumber(u.totals.completion_tokens)}</TD>
                    <TD className="py-3 text-right tabular-nums">{formatUsd(u.totals.cost_usd ?? 0)}</TD>
                    <TD className="py-3 text-right text-[13px] font-medium text-muted-foreground tabular-nums">100%</TD>
                  </tr>
                </tfoot>
              </Table>
            </Card>
          )}
        </div>
      )}
    </>
  )
}

const formatShare = (share: number) => `${formatNumber(share * 100)}%`

function chartSummary(days: UsageByDay[], metric: UsageMetric, t: TFunction) {
  const values = days.map((d) => metricValue(d, metric))
  const avg = values.reduce((a, b) => a + b, 0) / Math.max(1, values.length)
  const peakIdx = values.indexOf(Math.max(...values))
  const fmt = metric === 'tokens' ? formatCompact(avg) : metric === 'cost' ? formatUsd(avg) : formatNumber(avg, 1)
  return t('usage.chartSummary', { avg: fmt, peak: formatDay(days[peakIdx].date, { day: 'numeric', month: 'long' }) })
}

function Kpis({
  totals,
  prevTotals,
  days,
  costSpark,
}: {
  totals: UsageRow
  prevTotals?: UsageRow
  days: number
  costSpark: number[]
}) {
  const { t } = useTranslation()
  const runs = totals.runs ?? 0
  const calls = totals.llm_calls ?? 0
  const prompt = totals.prompt_tokens ?? 0
  const completion = totals.completion_tokens ?? 0
  const tokens = prompt + completion
  const cost = totals.cost_usd ?? 0
  const duration = totals.duration_s ?? 0
  const promptShare = tokens ? prompt / tokens : 0
  const vsPrev = t('usage.vsPrev', { count: days })
  const seconds = (s: number) => t('usage.seconds', { value: formatNumber(s, 1) })
  const minutes = (s: number) => {
    const h = Math.floor(s / 3600)
    const m = Math.round((s % 3600) / 60)
    return h ? t('usage.hoursMinutes', { h, m }) : t('usage.minutes', { value: m })
  }
  // мини-график стоимости: не больше 24 столбиков, длинный период складываем в группы дней
  const bucket = Math.max(1, Math.ceil(costSpark.length / 24))
  const spark: number[] = []
  for (let i = 0; i < costSpark.length; i += bucket) spark.push(costSpark.slice(i, i + bucket).reduce((a, b) => a + b, 0))
  const sparkMax = Math.max(...spark, 1e-9)

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Kpi
        label={t('usage.cost')}
        value={formatUsd(cost)}
        delta={<Delta value={pctChange(cost, prevTotals?.cost_usd)} title={vsPrev} />}
        aside={
          <span aria-hidden className="flex h-10 w-24 shrink-0 items-end gap-0.5">
            {spark.map((v, i) => (
              <span
                key={i}
                className={cn('min-w-px flex-1 rounded-t-[2px] bg-primary', i < spark.length - 1 && 'opacity-55')}
                style={{ height: `${Math.max(8, (v / sparkMax) * 100)}%` }}
              />
            ))}
          </span>
        }
      >
        <p className="text-xs text-muted-foreground">{t('usage.perRun', { value: runs ? formatUsd(cost / runs) : '—' })}</p>
      </Kpi>
      <Kpi label={t('usage.tokensTotal')} value={formatCompact(tokens)} delta={<Delta value={pctChange(tokens, prevTotals && (prevTotals.prompt_tokens ?? 0) + (prevTotals.completion_tokens ?? 0))} title={vsPrev} />}>
        <div className="grid gap-2">
          <div aria-hidden className="flex h-2 gap-0.5 overflow-hidden rounded-full bg-secondary">
            {tokens > 0 && (
              <>
                <span className="h-full bg-primary" style={{ width: `${promptShare * 100}%` }} />
                <span className="h-full flex-1 bg-primary/40" />
              </>
            )}
          </div>
          <div className="flex flex-wrap justify-between gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <Legend swatch="bg-primary" label={t('usage.prompt')} value={formatCompact(prompt)} />
            <Legend swatch="bg-primary/40" label={t('usage.completion')} value={formatCompact(completion)} />
          </div>
        </div>
      </Kpi>
      <Kpi label={t('usage.runs')} value={formatNumber(runs)} delta={<Delta value={pctChange(runs, prevTotals?.runs)} title={vsPrev} />}>
        <Facts
          items={[
            [t('usage.perDay'), formatNumber(runs / days, 1)],
            [t('usage.avgDuration'), runs ? seconds(duration / runs) : '—'],
          ]}
        />
      </Kpi>
      <Kpi label={t('usage.calls')} value={formatNumber(calls)}>
        <Facts
          items={[
            [t('usage.callsPerRun'), runs ? formatNumber(calls / runs, 1) : '—'],
            [t('usage.llmTime'), minutes(duration)],
          ]}
        />
      </Kpi>
    </div>
  )
}

function Kpi({ label, value, delta, aside, children }: { label: string; value: string; delta?: ReactNode; aside?: ReactNode; children?: ReactNode }) {
  return (
    <Card className="flex flex-col gap-4 p-5">
      <div className="flex min-h-[22px] items-center justify-between gap-2">
        <h2 className="text-[13px] font-medium text-muted-foreground">{label}</h2>
        {delta}
      </div>
      <div className="flex items-end justify-between gap-3">
        <div className="text-[2rem] leading-none font-semibold tracking-[-0.035em] tabular-nums">{value}</div>
        {aside}
      </div>
      {children}
    </Card>
  )
}

function Delta({ value, title }: { value: number | null; title: string }) {
  if (value === null || !Number.isFinite(value)) return null
  const up = value >= 0
  return (
    <span title={title} className="inline-flex h-[22px] items-center gap-1 rounded-full bg-secondary px-2 text-xs font-medium tabular-nums shadow-inset">
      {up ? <ArrowUp className="size-3" aria-hidden /> : <ArrowDown className="size-3" aria-hidden />}
      <span className="sr-only">{title}:</span>
      {up ? '+' : '−'}
      {formatNumber(Math.abs(value), 1)}%
    </span>
  )
}

function Facts({ items }: { items: [string, string][] }) {
  return (
    <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5 text-xs">
      {items.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="font-medium tabular-nums">{v}</dd>
        </div>
      ))}
    </dl>
  )
}

function Legend({ swatch, label, value }: { swatch: string; label: string; value?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className={cn('size-2 rounded-[2px]', swatch)} />
      {label}
      {value && <span className="font-medium text-foreground tabular-nums">{value}</span>}
    </span>
  )
}

function Segmented<V extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: V | undefined
  options: { value: V; label: string }[]
  onChange: (v: V) => void
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex h-9 items-center gap-0.5 rounded-xl bg-secondary p-[3px] shadow-inset">
      {options.map((o) => {
        const on = o.value === value
        return (
          <button
            key={String(o.value)}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.value)}
            className={cn(
              'h-[30px] cursor-pointer rounded-[9px] px-3 text-[13px] font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
              on ? 'bg-card text-foreground shadow-xs dark:bg-white/[0.09]' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

function SortTh({
  k,
  label,
  right,
  sort,
  onSort,
}: {
  k: SortKey
  label: string
  right?: boolean
  sort: { key: SortKey; desc: boolean }
  onSort: (s: { key: SortKey; desc: boolean }) => void
}) {
  const on = sort.key === k
  return (
    <TH className={cn(right && 'text-right')} aria-sort={on ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
      <button
        type="button"
        onClick={() => onSort(on ? { key: k, desc: !sort.desc } : { key: k, desc: k !== 'name' })}
        className={cn(
          'inline-flex cursor-pointer items-center gap-1 rounded-md py-1 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
          right && 'flex-row-reverse',
          on && 'text-foreground',
        )}
      >
        {label}
        {on ? (
          sort.desc ? (
            <ArrowDown className="size-3" aria-hidden />
          ) : (
            <ArrowUp className="size-3" aria-hidden />
          )
        ) : (
          <ChevronsUpDown className="size-3 opacity-45" aria-hidden />
        )}
      </button>
    </TH>
  )
}
