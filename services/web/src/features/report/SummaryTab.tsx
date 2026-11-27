import { useQuery } from '@tanstack/react-query'
import { Check, Minus, X } from 'lucide-react'
import { useMemo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '@/api/client'
import type { Criterion, Run, Severity } from '@/api/types'
import { ALL_CRITERIA, CRITERION_REFS, SET_CRITERIA, SEVERITIES, SEVERITY_RANK } from '@/shared/criteria'
import { formatClock } from '@/features/runs/agents'
import { formatDate, formatNumber, formatUsd } from '@/shared/format'
import { cn } from '@/shared/utils'
import { useReport } from './context'
import { FindingLinks, Linkified } from './tabs'

/*
 * «Сводка и итог»: вердикт, ключевые показатели, графики по критериям, свойствам набора,
 * типам требований и динамике по прогонам этого документа. Всё считается из отчёта
 * (и списка прогонов документа для динамики) — без выдуманных чисел.
 */

const SEV_FILL: Record<Severity, string> = { critical: 'bg-sev-critical', major: 'bg-sev-major', minor: 'bg-sev-minor' }
const SEV_STROKE: Record<Severity, string> = { critical: 'var(--sev-critical)', major: 'var(--sev-major)', minor: 'var(--sev-minor)' }

function Block({ title, aside, children, className }: { title: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('flex min-w-0 flex-col gap-4 rounded-2xl bg-card shadow-card p-5', className)}>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="label-mono flex items-center gap-2">
          <span aria-hidden className="inline-block size-1.5 rounded-full bg-primary" />
          {title}
        </h3>
        {aside && <span className="font-mono text-xs text-muted-foreground">{aside}</span>}
      </div>
      {children}
    </section>
  )
}

function SevLegend() {
  const { t } = useTranslation()
  return (
    <div className="flex flex-wrap gap-4 font-mono text-xs text-muted-foreground">
      {SEVERITIES.map((s) => (
        <span key={s} className="flex items-center gap-1.5">
          <span className={cn('inline-block size-2.5 rounded-full', SEV_FILL[s])} />
          {t(`severity.${s}`)}
        </span>
      ))}
    </div>
  )
}

export function SummaryTab({ run }: { run: Run }) {
  const { t } = useTranslation()
  const { report } = useReport()
  const { conclusion: c, summary: s } = report

  const stats = useMemo(() => {
    const reqIds = new Set(report.requirements.map((r) => r.id))
    const withFindings = new Set<string>()
    report.findings.forEach((f) => f.requirement_ids?.forEach((id) => reqIds.has(id) && withFindings.add(id)))
    const locs = report.findings.flatMap((f) => f.locations)
    const verified = locs.filter((l) => l.verified).length
    const sub = report.requirements.filter((r) => r.parent_id).length
    const rule = report.findings.filter((f) => f.source === 'rule').length
    const setScope = report.findings.filter((f) => f.scope === 'set').length

    // критерий × серьёзность
    const crit = new Map<Criterion, Record<Severity, number>>()
    report.findings.forEach((f) => {
      const row = crit.get(f.criterion) ?? { critical: 0, major: 0, minor: 0 }
      row[f.severity]++
      crit.set(f.criterion, row)
    })
    const byCriterion = ALL_CRITERIA.filter((k) => crit.has(k))
      .map((k) => ({ k, ...crit.get(k)!, total: SEVERITIES.reduce((n, sv) => n + crit.get(k)![sv], 0) }))
      .sort((a, b) => b.total - a.total)

    // тип требования: всего и с дефектами
    const kinds = new Map<string, { total: number; bad: number }>()
    report.requirements.forEach((r) => {
      const k = kinds.get(r.kind) ?? { total: 0, bad: 0 }
      k.total++
      if (withFindings.has(r.id)) k.bad++
      kinds.set(r.kind, k)
    })
    const byKind = [...kinds.entries()].sort((a, b) => b[1].total - a[1].total)

    // худший дефект по каждому требованию — для изометрической матрицы
    const worst: Record<string, Severity> = {}
    report.findings.forEach((f) =>
      f.requirement_ids?.forEach((id) => {
        if (!worst[id] || SEVERITY_RANK[f.severity] < SEVERITY_RANK[worst[id]]) worst[id] = f.severity
      }),
    )

    return {
      clean: report.requirements.length - withFindings.size,
      withFindings: withFindings.size,
      verified,
      locs: locs.length,
      sub,
      rule,
      llm: report.findings.length - rule,
      setScope,
      byCriterion,
      byKind,
      worst,
    }
  }, [report])

  const history = useQuery({
    queryKey: ['runs', { document_id: run.document_id }],
    queryFn: () => api.runs({ document_id: run.document_id, limit: 50 }),
  })
  const runsDone = useMemo(
    () =>
      (history.data?.items ?? [])
        .filter((r) => r.status === 'done' && r.summary)
        .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
        .slice(-8),
    [history.data],
  )
  const prev = runsDone.filter((r) => Date.parse(r.created_at) < Date.parse(run.created_at)).at(-1)
  const delta = prev?.summary ? s.findings_total - prev.summary.findings_total : null

  const u = report.usage ?? run.usage ?? {}
  const tokens = (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0)
  const reqTotal = s.requirements_total || report.requirements.length
  const kpis: { label: string; value: string; note: string; tone?: string }[] = [
    { label: t('stats.requirements'), value: formatNumber(reqTotal), note: stats.sub ? t('stats.subreqs', { count: stats.sub }) : t('stats.noSubreqs') },
    {
      label: t('stats.findings'),
      value: formatNumber(s.findings_total),
      note: delta == null ? t('stats.firstRun') : delta === 0 ? t('stats.deltaSame') : t(delta < 0 ? 'stats.deltaDown' : 'stats.deltaUp', { n: Math.abs(delta) }),
      tone: delta != null && delta < 0 ? 'text-teal' : delta != null && delta > 0 ? 'text-primary' : undefined,
    },
    {
      label: t('stats.clean'),
      value: report.requirements.length ? `${Math.round((stats.clean / report.requirements.length) * 100)} %` : '—',
      note: t('stats.cleanOf', { clean: stats.clean, total: report.requirements.length }),
    },
    {
      label: t('stats.density'),
      value: reqTotal ? formatNumber(s.findings_total / reqTotal, 2) : '—',
      note: t('stats.densityNote'),
    },
    {
      label: t('stats.quotes'),
      value: stats.locs ? `${Math.round((stats.verified / stats.locs) * 100)} %` : '—',
      note: t('stats.quotesOf', { ok: stats.verified, total: stats.locs }),
      tone: stats.locs && stats.verified === stats.locs ? 'text-teal' : undefined,
    },
    {
      label: t('stats.run'),
      value: u.duration_s != null ? formatClock(u.duration_s * 1000) : '—',
      note: tokens ? t('stats.tokens', { n: formatNumber(tokens) }) : t('stats.noUsage'),
    },
  ]

  const maxCrit = Math.max(1, ...stats.byCriterion.map((r) => r.total))
  const maxKind = Math.max(1, ...stats.byKind.map(([, k]) => k.total))
  const setChecks = new Map(report.set_assessment.checks.map((x) => [x.criterion, x]))
  const setPass = SET_CRITERIA.filter((k) => setChecks.get(k)?.verdict === 'pass').length
  const setKnown = SET_CRITERIA.filter((k) => setChecks.get(k)).length
  // матрица: квадрат из ячеек; чем меньше требований, тем крупнее ячейка
  const nReq = report.requirements.length
  const isoCols = Math.min(14, Math.max(3, Math.ceil(Math.sqrt(nReq))))
  const isoCell = nReq <= 16 ? 34 : nReq <= 64 ? 22 : 15

  return (
    <div className="grid gap-3 p-4">
      {/* Вердикт */}
      <section className="grid gap-3 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-4 rounded-2xl bg-card shadow-card p-6">
          <div
            className={cn(
              'inline-flex items-center gap-2 self-start rounded-full px-3 py-1 text-sm font-medium',
              c.ready_for_development ? 'bg-success/10 text-success' : 'bg-sev-critical-bg text-sev-critical',
            )}
          >
            <span className={cn('size-2 rounded-full', c.ready_for_development ? 'bg-success' : 'bg-primary')} />
            {t('report.verdict')} · {formatDate(report.passport.run_at)}
          </div>
          <p className="text-[1.375rem] leading-snug font-medium tracking-tight">
            <Linkified text={c.rationale} />
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {[
              [c.ready_for_development, t('report.readyForDev')],
              [c.ready_for_testing, t('report.readyForTest')],
            ].map(([ok, label]) => (
              <div key={String(label)} className={cn('flex items-center gap-3 rounded-xl px-3 py-2.5', ok ? 'bg-success/10' : 'bg-sev-critical-bg')}>
                <span className={cn('flex size-7 shrink-0 items-center justify-center rounded-full bg-card shadow-xs', ok ? 'text-success' : 'text-sev-critical')}>
                  {ok ? <Check className="size-3.5" /> : <X className="size-3.5" />}
                </span>
                <span className="text-sm">
                  {label}: <span className={ok ? 'text-teal' : 'text-primary'}>{ok ? t('report.yes') : t('report.no')}</span>
                </span>
              </div>
            ))}
          </div>
        </div>

        <Block title={t('report.topFixes')}>
          {c.top_fixes.length ? (
            <ol className="flex flex-col">
              {c.top_fixes.map((fix, i) => (
                <li key={i} className="rc-fade grid grid-cols-[28px_1fr] gap-2 border-b py-2.5 last:border-b-0" style={{ animationDelay: `${i * 0.06}s` }}>
                  <span className="font-mono text-sm text-muted-foreground">{String(i + 1).padStart(2, '0')}</span>
                  <span className="text-sm leading-relaxed">
                    <Linkified text={fix} />
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-sm text-muted-foreground">{t('report.nothingToFix')}</p>
          )}
          {s.critical_finding_ids.length > 0 && (
            <div className="text-sm">
              <div className="label-mono mb-1.5">{t('report.criticalIds')}</div>
              <FindingLinks ids={s.critical_finding_ids} />
            </div>
          )}
        </Block>
      </section>

      {/* Ключевые показатели */}
      <section aria-label={t('stats.kpis')} className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {kpis.map((k, i) => (
          <div key={k.label} className="rc-fade flex flex-col gap-1.5 rounded-2xl bg-card p-5 shadow-card" style={{ animationDelay: `${i * 0.06}s` }}>
            <span className="label-mono">{k.label}</span>
            <span className="text-[2rem] leading-tight font-medium tracking-tight tabular-nums">{k.value}</span>
            <span className={cn('self-start rounded-full bg-secondary px-2.5 py-0.5 text-xs text-muted-foreground', k.tone)}>{k.note}</span>
          </div>
        ))}
      </section>

      <section className="grid gap-3 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        {/* Дефекты по критериям × серьёзность */}
        <Block title={t('stats.byCriterion')} aside={t('report.findingCount', { count: s.findings_total })}>
          <SevLegend />
          {stats.byCriterion.length ? (
            <div role="table" aria-label={t('stats.byCriterion')} className="flex flex-col gap-2.5">
              {stats.byCriterion.map((r, i) => (
                <div key={r.k} role="row" className="grid grid-cols-[minmax(0,180px)_1fr_32px] items-center gap-3">
                  <span role="rowheader" className="truncate text-[0.8125rem]" title={`${t(`criteria.${r.k}.title`)} — ${CRITERION_REFS[r.k].join(', ')}`}>
                    {t(`criteria.${r.k}.title`)}
                  </span>
                  <span role="cell" className="flex h-3 gap-0.5 overflow-hidden rounded-full bg-secondary">
                    {SEVERITIES.map((sv) =>
                      r[sv] ? (
                        <span
                          key={sv}
                          className={cn('rc-grow block h-full rounded-full', SEV_FILL[sv])}
                          style={{ width: `${(r[sv] / maxCrit) * 100}%`, animationDelay: `${i * 0.05}s` }}
                          title={`${t(`criteria.${r.k}.title`)} · ${t(`severity.${sv}`)}: ${r[sv]}`}
                        />
                      ) : null,
                    )}
                  </span>
                  <span role="cell" className="text-right font-mono text-[0.8125rem] tabular-nums">
                    {r.total}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t('report.noFindings')}</p>
          )}
          <p className="font-mono text-xs text-muted-foreground">
            {t('stats.sources', { llm: stats.llm, rule: stats.rule, set: stats.setScope })}
          </p>
        </Block>

        {/* Свойства набора */}
        <Block title={t('stats.setProps')} aside={setKnown ? t('stats.setPass', { pass: setPass, total: setKnown }) : undefined}>
          <ul className="flex flex-col">
            {SET_CRITERIA.map((k, i) => {
              const chk = setChecks.get(k)
              const v = chk?.verdict
              const tone = v === 'pass' ? 'bg-success/10 text-success' : v === 'fail' ? 'bg-sev-critical-bg text-sev-critical' : 'bg-secondary text-muted-foreground'
              return (
                <li key={k} className="rc-fade flex items-center justify-between gap-3 border-b py-2.5 last:border-b-0" style={{ animationDelay: `${0.1 + i * 0.05}s` }}>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-sm">{t(`criteria.${k}.title`)}</span>
                    <span className="truncate text-xs text-muted-foreground" title={chk?.comment ?? undefined}>
                      {chk?.comment || CRITERION_REFS[k].join(' · ')}
                    </span>
                  </span>
                  <span className={cn('inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium', tone)}>
                    {v === 'pass' ? <Check className="size-3" /> : v === 'fail' ? <X className="size-3" /> : <Minus className="size-3" />}
                    {v ? t(`verdict.${v}`) : '—'}
                  </span>
                </li>
              )
            })}
          </ul>
        </Block>
      </section>

      <section className="grid gap-3 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        {/* Динамика по прогонам */}
        <Block title={t('stats.trend')} aside={runsDone.length ? t('stats.runs', { count: runsDone.length }) : undefined}>
          {runsDone.length >= 2 ? <TrendChart runs={runsDone} currentId={run.id} /> : <p className="text-sm text-muted-foreground">{t('stats.trendEmpty')}</p>}
        </Block>

        {/* По типам требований */}
        <Block title={t('stats.byKind')} aside={t('stats.byKindAside')}>
          <div role="table" aria-label={t('stats.byKind')} className="flex flex-col gap-3">
            {stats.byKind.map(([kind, k], i) => (
              <div key={kind} role="row" className="flex flex-col gap-1.5">
                <span className="flex justify-between text-[0.8125rem]">
                  <span role="rowheader">{t(`kind.${kind}`)}</span>
                  <span role="cell" className="font-mono text-xs text-muted-foreground">
                    {t('stats.kindOf', { bad: k.bad, total: k.total })}
                  </span>
                </span>
                <span role="cell" className="flex h-2.5 gap-0.5 overflow-hidden rounded-full" title={t('stats.kindOf', { bad: k.bad, total: k.total })}>
                  {k.bad > 0 && (
                    <span className="rc-grow block h-full rounded-full bg-accent-2" style={{ width: `${(k.bad / maxKind) * 100}%`, animationDelay: `${i * 0.06}s` }} />
                  )}
                  {k.total - k.bad > 0 && (
                    <span
                      className="rc-grow block h-full rounded-full bg-secondary"
                      style={{ width: `${((k.total - k.bad) / maxKind) * 100}%`, animationDelay: `${i * 0.06}s` }}
                    />
                  )}
                </span>
              </div>
            ))}
          </div>
          <div className="flex gap-4 font-mono text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="inline-block size-2.5 rounded-full bg-accent-2" />
              {t('stats.withFindings')}
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block size-2.5 rounded-full bg-input" />
              {t('stats.cleanShort')}
            </span>
          </div>
        </Block>
      </section>

      <section className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {/* Изометрическая матрица требований */}
        <Block title={t('stats.isoMatrix')} aside={t('stats.isoAside')}>
          <div className="relative flex h-72 items-center justify-center overflow-hidden [perspective:1600px]">
            <div className="rc-iso grid gap-1" style={{ gridTemplateColumns: `repeat(${isoCols}, ${isoCell}px)` }}>
              {report.requirements.map((r, i) => {
                const w = stats.worst[r.id]
                return (
                  <div
                    key={r.id}
                    className={cn('rc-iso-cell border', w ? SEV_FILL[w] : 'border-teal/60 bg-teal/10')}
                    style={{ width: isoCell, height: isoCell, animationDelay: `${Math.min(i, 120) * 0.012}s`, borderColor: w ? SEV_STROKE[w] : undefined }}
                    title={`${r.id} · ${w ? t(`severity.${w}`) : t('stats.cleanShort')}`}
                  />
                )
              })}
            </div>
          </div>
          <div className="flex flex-wrap gap-4 font-mono text-xs text-muted-foreground">
            <SevLegend />
            <span className="flex items-center gap-1.5">
              <span className="inline-block size-2.5 rounded-full border border-teal" />
              {t('stats.cleanShort')}
            </span>
          </div>
        </Block>

        {/* Расход */}
        <Block title={t('usage.title')}>
          <dl className="grid grid-cols-2 gap-2">
            {(
              [
                [t('usage.calls'), formatNumber(u.llm_calls)],
                [t('usage.promptTokens'), formatNumber(u.prompt_tokens)],
                [t('usage.completionTokens'), formatNumber(u.completion_tokens)],
                [t('usage.cost'), formatUsd(u.cost_usd)],
                [t('passport.model'), report.passport.model],
                [t('passport.provider'), t(`provider.${report.passport.provider}`, { defaultValue: report.passport.provider })],
              ] as [string, string][]
            ).map(([k, v]) => (
              <div key={k} className="flex min-w-0 flex-col gap-1 rounded-xl bg-secondary/70 p-3">
                <dt className="label-mono">{k}</dt>
                <dd className="truncate text-[0.9375rem] tabular-nums">{v}</dd>
              </div>
            ))}
          </dl>
        </Block>
      </section>
    </div>
  )
}

/** Дефекты по прогонам документа: все и критические, одна ось, подписи у последней точки. */
function TrendChart({ runs, currentId }: { runs: Run[]; currentId: string }) {
  const { t } = useTranslation()
  const W = 560
  const H = 220
  const L = 36
  const R = 40
  const T = 16
  const B = 34
  const totals = runs.map((r) => r.summary!.findings_total)
  const crit = runs.map((r) => r.summary!.by_severity?.critical ?? 0)
  const max = Math.max(4, ...totals)
  const step = Math.ceil(max / 3)
  const top = step * 3
  const x = (i: number) => L + (runs.length === 1 ? 0 : (i * (W - L - R)) / (runs.length - 1))
  const y = (v: number) => T + (1 - v / top) * (H - T - B)
  const line = (vals: number[]) => vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const last = runs.length - 1
  return (
    <>
      <div className="flex flex-wrap gap-4 font-mono text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-3.5 bg-foreground" />
          {t('stats.allFindings')}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-3.5 bg-sev-critical" />
          {t('severity.critical')}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full overflow-visible" role="img" aria-label={t('stats.trendAria', { values: totals.join(', ') })}>
        {[0, 1, 2, 3].map((k) => (
          <g key={k}>
            <line x1={L} x2={W - R} y1={y(k * step)} y2={y(k * step)} style={{ stroke: 'var(--border)' }} />
            <text x={L - 8} y={y(k * step) + 3} textAnchor="end" fontSize="10" style={{ fill: 'var(--muted-foreground)', fontFamily: 'var(--font-mono)' }}>
              {k * step}
            </text>
          </g>
        ))}
        <polygon
          className="rc-fade"
          points={`${line(totals)} ${x(last).toFixed(1)},${y(0)} ${x(0).toFixed(1)},${y(0)}`}
          style={{ fill: 'color-mix(in srgb, var(--foreground) 10%, transparent)', animationDelay: '.5s' }}
        />
        <polyline className="rc-draw" points={line(totals)} fill="none" strokeWidth="2" strokeLinejoin="round" style={{ stroke: 'var(--foreground)' }} />
        <polyline className="rc-draw" points={line(crit)} fill="none" strokeWidth="2" strokeLinejoin="round" style={{ stroke: 'var(--sev-critical)' }} />
        {runs.map((r, i) => {
          const cur = r.id === currentId
          return (
            <g key={r.id}>
              <title>{`${formatDate(r.created_at)} · ${t('report.findingCount', { count: totals[i] })} · ${t('severity.critical')}: ${crit[i]}`}</title>
              <rect x={x(i) - 14} y={T} width="28" height={H - T - B} fill="transparent" />
              {cur && <line x1={x(i)} x2={x(i)} y1={T} y2={H - B} strokeDasharray="3 4" style={{ stroke: 'var(--muted-foreground)' }} />}
              <circle cx={x(i)} cy={y(totals[i])} r={cur ? 5.5 : 4.5} strokeWidth="2" style={{ fill: 'var(--foreground)', stroke: 'var(--card)' }} />
              <circle cx={x(i)} cy={y(crit[i])} r={cur ? 5.5 : 4.5} strokeWidth="2" style={{ fill: 'var(--sev-critical)', stroke: 'var(--card)' }} />
              <text
                x={x(i)}
                y={H - 10}
                textAnchor="middle"
                fontSize="10"
                style={{ fill: cur ? 'var(--foreground)' : 'var(--muted-foreground)', fontFamily: 'var(--font-mono)' }}
              >
                {new Date(r.created_at).toLocaleDateString([], { day: '2-digit', month: '2-digit' })}
              </text>
            </g>
          )
        })}
        <text x={x(last) + 10} y={y(totals[last]) + 4} fontSize="14" fontWeight="600" style={{ fill: 'var(--foreground)' }}>
          {totals[last]}
        </text>
        <text x={x(last) + 10} y={y(crit[last]) + 4} fontSize="12" fontWeight="600" style={{ fill: 'var(--foreground)' }}>
          {crit[last]}
        </text>
      </svg>
    </>
  )
}
