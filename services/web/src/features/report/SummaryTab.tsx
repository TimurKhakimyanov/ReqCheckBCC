import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '@/api/client'
import type { CheckVerdict, Criterion, Run, Severity } from '@/api/types'
import { ALL_CRITERIA, CRITERION_REFS, SET_CRITERIA, SEVERITIES } from '@/shared/criteria'
import { formatDate, formatNumber } from '@/shared/format'
import { cn } from '@/shared/utils'
import { useReport } from './context'
import { FindingLinks, Linkified } from './tabs'
import { EYEBROW, Panel, SEV_BG, TonePill } from './ui'

/*
 * «Сводка и итог»: вердикт и что исправить первым, ключевые показатели, дефекты по критериям,
 * динамика по прогонам документа, доля требований с дефектами по типам, свойства набора.
 * Всё считается из отчёта (и списка прогонов документа для динамики) — без выдуманных чисел.
 */

function SevLegend() {
  const { t } = useTranslation()
  return (
    <div className="flex flex-wrap gap-3.5 font-mono text-[11px] text-muted-foreground">
      {SEVERITIES.map((s) => (
        <span key={s} className="flex items-center gap-1.5">
          <span className={cn('inline-block size-[9px]', SEV_BG[s])} />
          {t(`severity.${s}`)}
        </span>
      ))}
    </div>
  )
}

const VERDICT_TONE: Record<CheckVerdict, 'ok' | 'bad' | 'muted'> = { pass: 'ok', fail: 'bad', not_applicable: 'muted' }
const VERDICT_ICON: Record<CheckVerdict, string> = { pass: '✓', fail: '✕', not_applicable: '—' }

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

    return {
      clean: report.requirements.length - withFindings.size,
      verified,
      locs: locs.length,
      sub,
      rule,
      llm: report.findings.length - rule,
      setScope,
      byCriterion,
      byKind,
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
  const trendDelta =
    runsDone.length >= 2 && runsDone[0].summary!.findings_total > 0
      ? Math.round(((runsDone.at(-1)!.summary!.findings_total - runsDone[0].summary!.findings_total) / runsDone[0].summary!.findings_total) * 100)
      : null

  const questions = report.questions ?? []
  const blockers = questions.filter((q) => q.priority === 'blocker').length
  const reqTotal = s.requirements_total || report.requirements.length
  const kpis: { label: string; value: string; note: string; tone?: string }[] = [
    { label: t('stats.requirements'), value: formatNumber(reqTotal), note: stats.sub ? t('stats.subreqs', { count: stats.sub }) : t('stats.noSubreqs') },
    {
      label: t('stats.findings'),
      value: formatNumber(s.findings_total),
      note: delta == null ? t('stats.firstRun') : delta === 0 ? t('stats.deltaSame') : t(delta < 0 ? 'stats.deltaDown' : 'stats.deltaUp', { n: Math.abs(delta) }),
      tone: delta != null && delta < 0 ? 'text-teal' : delta != null && delta > 0 ? 'text-sev-critical' : undefined,
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
      tone: stats.locs && stats.verified === stats.locs ? 'text-teal' : stats.verified < stats.locs ? 'text-warning' : undefined,
    },
    {
      label: t('stats.questions'),
      value: questions.length ? formatNumber(questions.length) : '—',
      note: questions.length ? t('stats.questionsBlockers', { n: blockers }) : t('stats.noQuestions'),
      tone: blockers ? 'text-sev-critical' : undefined,
    },
  ]

  const maxCrit = Math.max(1, ...stats.byCriterion.map((r) => r.total))
  const maxKind = Math.max(1, ...stats.byKind.map(([, k]) => k.total))
  const setChecks = new Map(report.set_assessment.checks.map((x) => [x.criterion, x]))
  const setPass = SET_CRITERIA.filter((k) => setChecks.get(k)?.verdict === 'pass').length
  const setKnown = SET_CRITERIA.filter((k) => setChecks.get(k)).length

  return (
    <div className="flex flex-col gap-4 p-4 sm:p-5">
      {/* Итог и что исправить первым */}
      <section className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr))]">
        <Panel title={`${t('report.verdict')} · ${formatDate(report.passport.run_at)}`} className="gap-3.5 p-6">
          <p className="text-xl leading-snug font-medium tracking-tight">
            <Linkified text={c.rationale} />
          </p>
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                [c.ready_for_development, t('report.devShort')],
                [c.ready_for_testing, t('report.testShort')],
              ] as [boolean, string][]
            ).map(([ok, label]) => (
              <div key={label} className={cn('flex items-center gap-2.5 border px-3 py-2.5 text-[0.8125rem]', ok ? 'border-teal/35 bg-teal/5' : 'border-sev-critical/35 bg-sev-critical-bg')}>
                <strong className={cn('font-semibold', ok ? 'text-teal' : 'text-sev-critical')}>
                  {ok ? '✓' : '✕'} {ok ? t('report.yes') : t('report.no')}
                </strong>
                {label}
              </div>
            ))}
          </div>
        </Panel>

        <Panel title={t('report.topFixes')} className="p-6">
          {c.top_fixes.length ? (
            <ol className="flex flex-col">
              {c.top_fixes.map((fix, i) => (
                <li key={i} className="grid grid-cols-[30px_1fr] items-baseline gap-2 border-b py-2.5 text-sm leading-normal last:border-b-0">
                  <span className="font-mono text-xs text-muted-foreground">{String(i + 1).padStart(2, '0')}</span>
                  <span>
                    <Linkified text={fix} />
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-sm text-muted-foreground">{t('report.nothingToFix')}</p>
          )}
          {s.critical_finding_ids.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className={EYEBROW}>{t('report.criticalIds')}</span>
              <FindingLinks ids={s.critical_finding_ids} />
            </div>
          )}
        </Panel>
      </section>

      {/* Ключевые показатели */}
      <section aria-label={t('stats.kpis')} className="grid border-t border-l bg-card [grid-template-columns:repeat(auto-fit,minmax(min(100%,170px),1fr))]">
        {kpis.map((k) => (
          <div key={k.label} className="flex flex-col gap-1 border-r border-b px-4.5 py-4">
            <span className={EYEBROW}>{k.label}</span>
            <span className="text-[1.875rem] leading-tight font-medium tracking-tight tabular-nums">{k.value}</span>
            <span className={cn('font-mono text-xs text-muted-foreground', k.tone)}>{k.note}</span>
          </div>
        ))}
      </section>

      <section className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr))]">
        {/* Дефекты по критериям × серьёзность */}
        <Panel title={t('stats.byCriterion')} aside={formatNumber(s.findings_total)}>
          <SevLegend />
          {stats.byCriterion.length ? (
            <div role="table" aria-label={t('stats.byCriterion')} className="flex flex-col gap-2.5">
              {stats.byCriterion.map((r, i) => (
                <div key={r.k} role="row" className="grid grid-cols-[minmax(0,170px)_1fr_28px] items-center gap-2.5">
                  <span role="rowheader" className="truncate text-[0.8125rem]" title={`${t(`criteria.${r.k}.title`)} — ${CRITERION_REFS[r.k].join(', ')}`}>
                    {t(`criteria.${r.k}.title`)}
                  </span>
                  <span role="cell" className="flex h-3 gap-0.5">
                    {SEVERITIES.map((sv) =>
                      r[sv] ? (
                        <span
                          key={sv}
                          className={cn('rc-grow block h-full', SEV_BG[sv])}
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
          <p className="font-mono text-xs text-muted-foreground">{t('stats.sources', { llm: stats.llm, rule: stats.rule, set: stats.setScope })}</p>
        </Panel>

        {/* Динамика по прогонам */}
        <Panel
          title={t('stats.trend')}
          aside={
            trendDelta != null ? (
              <span className={trendDelta < 0 ? 'text-teal' : trendDelta > 0 ? 'text-sev-critical' : undefined}>
                {t('stats.trendDelta', { pct: `${trendDelta > 0 ? '+' : trendDelta < 0 ? '−' : ''}${Math.abs(trendDelta)}`, count: runsDone.length })}
              </span>
            ) : undefined
          }
        >
          {runsDone.length >= 2 ? <TrendChart runs={runsDone} currentId={run.id} /> : <p className="text-sm text-muted-foreground">{t('stats.trendEmpty')}</p>}
        </Panel>
      </section>

      <section className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr))]">
        {/* По типам требований */}
        <Panel title={`${t('stats.byKind')} · ${t('stats.byKindAside')}`}>
          <div role="table" aria-label={t('stats.byKind')} className="flex flex-col gap-2.5">
            {stats.byKind.map(([kind, k], i) => (
              <div key={kind} role="row" className="flex flex-col gap-1.5">
                <span className="flex justify-between text-[0.8125rem]">
                  <span role="rowheader">{t(`kind.${kind}`)}</span>
                  <span role="cell" className="font-mono text-xs text-muted-foreground">
                    {t('stats.kindOf', { bad: k.bad, total: k.total })}
                  </span>
                </span>
                <span role="cell" className="flex h-2 gap-0.5" title={t('stats.kindOf', { bad: k.bad, total: k.total })}>
                  {k.bad > 0 && <span className="rc-grow block h-full bg-foreground" style={{ width: `${(k.bad / maxKind) * 100}%`, animationDelay: `${i * 0.06}s` }} />}
                  {k.total - k.bad > 0 && (
                    <span className="rc-grow block h-full bg-input" style={{ width: `${((k.total - k.bad) / maxKind) * 100}%`, animationDelay: `${i * 0.06}s` }} />
                  )}
                </span>
              </div>
            ))}
          </div>
          <div className="flex gap-4 font-mono text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="inline-block size-[9px] bg-foreground" />
              {t('stats.withFindings')}
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block size-[9px] bg-input" />
              {t('stats.cleanShort')}
            </span>
          </div>
        </Panel>

        {/* Свойства набора — коротко; подробно в разделе «Проверка набора» */}
        <Panel title={t('stats.setProps')} aside={setKnown ? t('stats.setPass', { pass: setPass, total: setKnown }) : undefined}>
          <ul className="flex flex-col">
            {SET_CRITERIA.map((k) => {
              const chk = setChecks.get(k)
              const v = chk?.verdict
              return (
                <li key={k} className="flex items-center justify-between gap-3 border-b py-2 last:border-b-0">
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-[0.8125rem]">{t(`criteria.${k}.title`)}</span>
                    <span className="truncate text-xs text-muted-foreground" title={chk?.comment ?? undefined}>
                      {chk?.comment || CRITERION_REFS[k].join(' · ')}
                    </span>
                  </span>
                  {v ? (
                    <TonePill tone={VERDICT_TONE[v]}>
                      {VERDICT_ICON[v]} {t(`verdict.${v}`)}
                    </TonePill>
                  ) : (
                    <TonePill tone="muted">—</TonePill>
                  )}
                </li>
              )
            })}
          </ul>
        </Panel>
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
      <div className="flex flex-wrap gap-3.5 font-mono text-[11px] text-muted-foreground">
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
