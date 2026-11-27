// Столбчатый график расхода по дням: шкала с «круглыми» делениями, подсказка при наведении и фокусе.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { UsageByDay } from '@/api/types'
import { formatCompact, formatDay, formatNumber, formatUsd } from '@/shared/format'
import { cn } from '@/shared/utils'
import { metricValue, niceMax, tokensOf, type UsageMetric } from './usage'

export function DailyChart({ days, metric }: { days: UsageByDay[]; metric: UsageMetric }) {
  const { t } = useTranslation()
  const [hover, setHover] = useState<number | null>(null)
  const n = days.length
  const max = Math.max(0, ...days.map((d) => metricValue(d, metric)))
  const top = metric === 'runs' ? Math.max(4, Math.ceil(max / 4) * 4) : niceMax(max)
  const tick = (v: number) => (metric === 'tokens' ? formatCompact(v) : metric === 'cost' ? `$${+v.toFixed(4)}` : formatNumber(v))
  const gap = n <= 14 ? 10 : n <= 31 ? 4 : n <= 120 ? 2 : 1
  const labelStep = Math.max(1, Math.ceil(n / 8))
  const rounded = n > 45 ? 'rounded-t-[2px]' : 'rounded-t-[4px]'
  const mainColor = metric === 'runs' ? 'bg-accent-2' : 'bg-primary'

  return (
    <div className="mt-4 grid grid-cols-[56px_minmax(0,1fr)]">
      <div aria-hidden className="relative h-60">
        {[0, 1, 2, 3, 4].map((i) => (
          <span
            key={i}
            className="absolute right-3 translate-y-1/2 text-[11px] whitespace-nowrap text-muted-foreground tabular-nums"
            style={{ bottom: `${i * 25}%` }}
          >
            {tick((top * i) / 4)}
          </span>
        ))}
      </div>
      <div className="relative h-60">
        {[0, 1, 2, 3, 4].map((i) => (
          <span
            key={i}
            aria-hidden
            className={cn('absolute inset-x-0 border-t', i > 0 && 'border-dashed')}
            style={{ bottom: `${i * 25}%` }}
          />
        ))}
        <div role="group" aria-label={t('usage.byDay')} className="absolute inset-0 flex justify-center" style={{ gap }}>
          {days.map((d, i) => {
            const bottom = ((metric === 'tokens' ? (d.prompt_tokens ?? 0) : metricValue(d, metric)) / top) * 100
            const upper = metric === 'tokens' ? ((d.completion_tokens ?? 0) / top) * 100 : 0
            const active = hover === i
            const full = formatDay(d.date, { weekday: 'short', day: 'numeric', month: 'long' })
            return (
              <button
                key={d.date}
                type="button"
                aria-label={`${full}: ${t('usage.tokensTotal')} ${formatNumber(tokensOf(d))}, ${t('usage.cost')} ${formatUsd(d.cost_usd ?? 0)}, ${t('usage.runs')} ${d.runs ?? 0}`}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                className={cn(
                  'relative flex h-full max-w-14 min-w-0 flex-1 cursor-default flex-col justify-end outline-none transition-opacity duration-200 focus-visible:ring-2 focus-visible:ring-ring',
                  hover !== null && !active && 'opacity-40',
                )}
              >
                {active && <span aria-hidden className="absolute -inset-x-1 -top-2 bottom-0 rounded-lg bg-secondary" />}
                <span className={cn('relative block bg-primary/40', rounded)} style={{ height: `${upper}%` }} />
                <span className={cn('relative block', mainColor, upper > 0 ? '' : rounded)} style={{ height: `${bottom}%` }} />
                {active && (
                  <span
                    role="tooltip"
                    className={cn(
                      'pointer-events-none absolute z-10 block w-max min-w-52 rounded-xl bg-popover px-3 py-2.5 text-left text-popover-foreground shadow-raised',
                      i < n * 0.25 ? 'left-0' : i >= n * 0.75 ? 'right-0' : 'left-1/2 -translate-x-1/2',
                    )}
                    style={{ bottom: `calc(${bottom + upper}% + 12px)` }}
                  >
                    <span className="mb-2 block text-xs font-semibold">{full}</span>
                    <TipLine swatch="bg-primary" label={t('usage.promptTokens')} value={formatNumber(d.prompt_tokens ?? 0)} />
                    <TipLine swatch="bg-primary/40" label={t('usage.completionTokens')} value={formatNumber(d.completion_tokens ?? 0)} />
                    <TipLine swatch="border-[1.5px] border-muted-foreground" label={t('usage.cost')} value={formatUsd(d.cost_usd ?? 0)} />
                    <TipLine swatch="bg-accent-2" label={t('usage.runsCalls')} value={`${d.runs ?? 0} · ${d.llm_calls ?? 0}`} />
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </div>
      <div />
      <div aria-hidden className="flex justify-center" style={{ gap }}>
        {days.map((d, i) => (
          <span key={d.date} className="relative h-7 max-w-14 min-w-0 flex-1">
            {(n - 1 - i) % labelStep === 0 && (
              <span className="absolute top-2 left-1/2 -translate-x-1/2 text-[11px] whitespace-nowrap text-muted-foreground tabular-nums">
                {formatDay(d.date, { day: 'numeric', month: 'short' })}
              </span>
            )}
          </span>
        ))}
      </div>
    </div>
  )
}

function TipLine({ swatch, label, value }: { swatch: string; label: string; value: string }) {
  return (
    <span className="flex items-center gap-2 text-xs leading-5">
      <span aria-hidden className={cn('size-2 shrink-0 rounded-[2px]', swatch)} />
      <span className="flex-1 whitespace-nowrap text-muted-foreground">{label}</span>
      <span className="font-medium whitespace-nowrap tabular-nums">{value}</span>
    </span>
  )
}
