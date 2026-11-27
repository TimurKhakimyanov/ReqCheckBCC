import { Copy, Download, Search } from 'lucide-react'
import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { CheckVerdict, ChecklistAnswer, CriterionCheck, ExportFormat, QuestionPriority, RequirementKind, Run, Severity } from '@/api/types'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/misc'
import { CRITERION_REFS, REQUIREMENT_CRITERIA, SET_CRITERIA, SEVERITIES, SEVERITY_RANK } from '@/shared/criteria'
import { formatDate, formatDuration, formatNumber, formatUsd } from '@/shared/format'
import { cn } from '@/shared/utils'
import { useReport } from './context'
import { EYEBROW, FilterChip, Panel, SEV_BG, SevSquare, TonePill } from './ui'

/** Делает ссылки D-001 / R-002 в тексте кликабельными. */
export function Linkified({ text }: { text: string }) {
  const { findingsById, goToFinding, goToRequirement } = useReport()
  const parts = text.split(/\b([DR]-\d{3}(?:\.\d+)?)\b/)
  return (
    <>
      {parts.map((p, i) => {
        if (i % 2 === 0) return <Fragment key={i}>{p}</Fragment>
        if (p.startsWith('D-') && findingsById[p])
          return (
            <button key={i} type="button" className="cursor-pointer font-mono font-medium text-sev-major hover:underline" onClick={() => goToFinding(p)}>
              {p}
            </button>
          )
        if (p.startsWith('R-'))
          return (
            <button key={i} type="button" className="cursor-pointer font-mono font-medium text-sev-major hover:underline" onClick={() => goToRequirement(p)}>
              {p}
            </button>
          )
        return <Fragment key={i}>{p}</Fragment>
      })}
    </>
  )
}

export function FindingLinks({ ids }: { ids?: string[] }) {
  const { findingsById, goToFinding } = useReport()
  if (!ids?.length) return null
  return (
    <span className="inline-flex flex-wrap gap-1">
      {ids.map((id) => {
        const f = findingsById[id]
        return (
          <button
            key={id}
            type="button"
            onClick={() => goToFinding(id)}
            className="rc-focusable inline-flex cursor-pointer items-center gap-1.5 border px-1.5 font-mono text-xs transition-colors hover:border-foreground/40 hover:bg-secondary"
            title={f?.title}
          >
            {f && <SevSquare severity={f.severity} className="size-2" />}
            {id}
          </button>
        )
      })}
    </span>
  )
}

const VERDICT_TONE: Record<CheckVerdict, 'ok' | 'bad' | 'muted'> = { pass: 'ok', fail: 'bad', not_applicable: 'muted' }
const VERDICT_ICON: Record<CheckVerdict, string> = { pass: '✓', fail: '✕', not_applicable: '—' }

function Page({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex flex-col gap-4 p-4 sm:p-5', className)}>{children}</div>
}

function SearchBox({ value, onChange, label, placeholder }: { value: string; onChange: (v: string) => void; label: string; placeholder: string }) {
  return (
    <label className="flex min-h-9 min-w-0 flex-[1_1_240px] items-center gap-2 border border-input bg-card px-2.5 focus-within:border-foreground/50">
      <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="sr-only">{label}</span>
      <input
        type="search"
        className="min-w-0 flex-1 bg-transparent text-[0.8125rem] outline-none placeholder:text-muted-foreground/80"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  )
}

function countBySeverity(ids: Iterable<string>, findingsById: Record<string, { severity: Severity }>) {
  const c: Record<Severity, number> = { critical: 0, major: 0, minor: 0 }
  for (const id of ids) {
    const f = findingsById[id]
    if (f) c[f.severity]++
  }
  return c
}

// ---------------------------------------------------------------- Нарезка требований
export function RequirementsTab() {
  const { t } = useTranslation()
  const { report, findingsById, goToRequirement, showRequirementFindings } = useReport()
  const [q, setQ] = useState('')
  const [kind, setKind] = useState<RequirementKind | ''>('')
  const [onlyBad, setOnlyBad] = useState(false)

  const perReq = useMemo(() => {
    const ids: Record<string, Set<string>> = {}
    report.findings.forEach((f) => f.requirement_ids?.forEach((r) => (ids[r] ??= new Set()).add(f.id)))
    return Object.fromEntries(Object.entries(ids).map(([r, s]) => [r, countBySeverity(s, findingsById)]))
  }, [report.findings, findingsById])
  const kinds = useMemo(() => {
    const m = new Map<RequirementKind, number>()
    report.requirements.forEach((r) => m.set(r.kind, (m.get(r.kind) ?? 0) + 1))
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [report.requirements])

  if (!report.requirements.length) return <EmptyState title={t('report.noRequirements')} />

  const needle = q.trim().toLowerCase()
  const total = (id: string) => SEVERITIES.reduce((n, s) => n + (perReq[id]?.[s] ?? 0), 0)
  const rows = report.requirements.filter(
    (r) =>
      (!kind || r.kind === kind) &&
      (!onlyBad || total(r.id) > 0) &&
      (!needle || [r.id, r.source_id ?? '', r.summary, r.location.quote].some((s) => s.toLowerCase().includes(needle))),
  )
  const hasSub = report.requirements.some((r) => r.parent_id)

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b bg-card px-4 py-3 sm:px-5">
        <SearchBox value={q} onChange={setQ} label={t('report.searchReqs')} placeholder={t('report.searchReqsPlaceholder')} />
        <span className={cn(EYEBROW, 'ml-1')}>{t('report.kind')}</span>
        <FilterChip pressed={!kind} onClick={() => setKind('')}>
          {t('report.allKinds')} <span className="font-mono text-muted-foreground">{report.requirements.length}</span>
        </FilterChip>
        {kinds.map(([k, n]) => (
          <FilterChip key={k} pressed={kind === k} onClick={() => setKind(kind === k ? '' : k)}>
            {t(`kind.${k}`)} <span className="font-mono text-muted-foreground">{n}</span>
          </FilterChip>
        ))}
        <label className="ml-auto flex cursor-pointer items-center gap-2 text-[0.8125rem]">
          <input type="checkbox" className="size-4 cursor-pointer accent-[var(--report-accent)]" checked={onlyBad} onChange={(e) => setOnlyBad(e.target.checked)} />
          {t('report.onlyWithFindings')}
        </label>
      </div>
      <Page>
        <div className="overflow-x-auto border bg-card">
          <table className="w-full min-w-[860px] border-collapse text-sm">
            <thead>
              <tr className={cn(EYEBROW, 'bg-secondary/60 text-left')}>
                <th className="border-b px-3.5 py-2.5 font-medium">ID</th>
                <th className="border-b px-3.5 py-2.5 font-medium">{t('report.sourceId')}</th>
                <th className="border-b px-3.5 py-2.5 font-medium">{t('report.kind')}</th>
                <th className="w-[46%] border-b px-3.5 py-2.5 font-medium">{t('report.reqWording')}</th>
                <th className="border-b px-3.5 py-2.5 font-medium">{t('documents.findings')}</th>
                <th className="border-b px-3.5 py-2.5 font-medium">
                  <span className="sr-only">{t('report.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const c = perReq[r.id]
                const n = total(r.id)
                return (
                  <tr key={r.id} className={cn('border-b last:border-b-0 hover:bg-secondary/40', r.parent_id && 'bg-secondary/30')}>
                    <td className={cn('py-3 pr-3.5 align-top font-mono text-[0.8125rem] whitespace-nowrap', r.parent_id ? 'pl-8' : 'pl-3.5')}>
                      {r.parent_id ? '↳ ' : ''}
                      {r.id}
                    </td>
                    <td className="px-3.5 py-3 align-top font-mono text-xs text-muted-foreground">{r.source_id ?? '—'}</td>
                    <td className="px-3.5 py-3 align-top">
                      <span className="border px-1.5 py-0.5 font-mono text-[11px] whitespace-nowrap">{t(`kind.${r.kind}`)}</span>
                    </td>
                    <td className="px-3.5 py-3 align-top">
                      <div className="leading-snug font-medium">{r.summary}</div>
                      <div className="mt-1 text-[0.8125rem] leading-normal text-muted-foreground" title={r.location.section}>
                        «{r.location.quote}»
                      </div>
                    </td>
                    <td className="px-3.5 py-3 align-top">
                      {n ? (
                        <button
                          type="button"
                          className="rc-focusable inline-flex cursor-pointer gap-2.5 font-mono text-xs hover:underline"
                          onClick={() => showRequirementFindings(r.id)}
                          title={t('report.showReqFindings')}
                        >
                          {SEVERITIES.map((s) => (
                            <span key={s} className={cn('inline-flex items-center gap-1', !c?.[s] && 'text-muted-foreground/60')}>
                              <span aria-hidden className={cn('inline-block size-2', SEV_BG[s], !c?.[s] && 'opacity-25')} />
                              <span className="sr-only">{t(`severity.${s}`)}</span>
                              {c?.[s] ?? 0}
                            </span>
                          ))}
                        </button>
                      ) : (
                        <span className="font-mono text-xs text-muted-foreground">0</span>
                      )}
                    </td>
                    <td className="px-3.5 py-3 text-right align-top whitespace-nowrap">
                      <button type="button" className="cursor-pointer font-mono text-xs text-sev-major hover:underline" onClick={() => goToRequirement(r.id)}>
                        {t('report.inDocument')}
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {rows.length === 0 && <p className="px-4 py-6 text-center text-sm text-muted-foreground">{t('report.noReqMatches')}</p>}
        </div>
        <p className="text-[0.8125rem] text-muted-foreground">
          {t('report.reqShown', { shown: rows.length, total: report.requirements.length })}
          {hasSub && ` ${t('report.subreqHint')}`}
        </p>
      </Page>
    </div>
  )
}

// ---------------------------------------------------------------- Матрица требование × критерий
export function MatrixTab() {
  const { t } = useTranslation()
  const { report, findingsById, goToFinding, goToRequirement } = useReport()
  const byReq = useMemo(() => {
    const m: Record<string, Record<string, CriterionCheck>> = {}
    report.requirement_assessments.forEach((a) => {
      m[a.requirement_id] = Object.fromEntries(a.checks.map((c) => [c.criterion, c]))
    })
    return m
  }, [report.requirement_assessments])

  const worst = (ids: string[] = []): Severity | null =>
    ids
      .map((id) => findingsById[id]?.severity)
      .filter(Boolean)
      .sort((a, b) => SEVERITY_RANK[a!] - SEVERITY_RANK[b!])[0] ?? null

  // требования с дефектами — сверху (порядок документа среди равных)
  const rows = useMemo(() => {
    const total = (id: string) => {
      const s = new Set<string>()
      Object.values(byReq[id] ?? {}).forEach((c) => c.verdict === 'fail' && c.finding_ids?.forEach((f) => s.add(f)))
      return s.size
    }
    return report.requirements.map((r, i) => ({ r, i, total: total(r.id) })).sort((a, b) => b.total - a.total || a.i - b.i)
  }, [report.requirements, byReq])

  if (!report.requirements.length) return <EmptyState title={t('report.noRequirements')} />

  const cell = 'flex h-[34px] min-w-[52px] items-center justify-center border font-mono text-xs font-semibold'
  return (
    <Page>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-foreground/80">{t('report.matrixIntro')}</p>
        <div className="flex flex-wrap gap-3.5 font-mono text-[11px] text-muted-foreground">
          {SEVERITIES.map((s) => (
            <span key={s} className="inline-flex items-center gap-1.5">
              <span className={cn('inline-block size-3', SEV_BG[s])} />
              {t(`severity.${s}`)}
            </span>
          ))}
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block size-3 border border-teal/40 bg-teal/10" />
            {t('verdict.pass')}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block size-3 bg-secondary" />
            {t('verdict.not_applicable')}
          </span>
        </div>
      </div>
      <div className="overflow-x-auto border bg-card">
        <table className="w-full min-w-[880px] border-separate border-spacing-[3px] text-[0.8125rem]">
          <thead>
            <tr>
              <th scope="col" className={cn(EYEBROW, 'sticky left-0 z-10 bg-card px-2.5 py-2 text-left')}>
                {t('report.requirement')}
              </th>
              {REQUIREMENT_CRITERIA.map((c) => (
                <th
                  key={c}
                  scope="col"
                  className="px-0.5 py-1.5 text-center text-[11px] leading-tight font-medium text-foreground/80"
                  title={`${t(`criteria.${c}.title`)} · ${CRITERION_REFS[c].join(', ')}`}
                >
                  {t(`criteria.${c}.short`)}
                </th>
              ))}
              <th scope="col" className={cn(EYEBROW, 'px-2 py-1.5 text-right')}>
                {t('report.matrixTotal')}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ r, total }) => (
              <tr key={r.id}>
                <th scope="row" className="sticky left-0 z-10 bg-card px-2.5 py-1 text-left font-normal whitespace-nowrap">
                  <button type="button" className="cursor-pointer font-mono text-xs font-medium hover:underline" onClick={() => goToRequirement(r.id)} title={r.summary}>
                    {r.id}
                  </button>
                  {r.source_id && <span className="ml-1.5 text-xs text-muted-foreground">{r.source_id}</span>}
                </th>
                {REQUIREMENT_CRITERIA.map((c) => {
                  const chk = byReq[r.id]?.[c]
                  const name = t(`criteria.${c}.title`)
                  if (!chk)
                    return (
                      <td key={c} className="p-0">
                        <span className={cn(cell, 'border-transparent font-normal text-muted-foreground')}>·</span>
                      </td>
                    )
                  if (chk.verdict === 'pass')
                    return (
                      <td key={c} className="p-0">
                        <span className={cn(cell, 'border-teal/25 bg-teal/10 text-teal')} title={`${r.id} · ${name}: ${t('verdict.pass')}`} aria-label={`${r.id} · ${name}: ${t('verdict.pass')}`}>
                          ✓
                        </span>
                      </td>
                    )
                  if (chk.verdict === 'not_applicable')
                    return (
                      <td key={c} className="p-0">
                        <span
                          className={cn(cell, 'border-transparent bg-secondary font-normal text-muted-foreground')}
                          title={`${r.id} · ${name}: ${t('verdict.not_applicable')}`}
                          aria-label={`${r.id} · ${name}: ${t('verdict.not_applicable')}`}
                        >
                          —
                        </span>
                      </td>
                    )
                  const ids = chk.finding_ids ?? []
                  const sev = worst(ids)
                  const tip = [`${r.id} · ${name}: ${t('verdict.fail')}`, ids.join(', '), chk.comment].filter(Boolean).join(' — ')
                  return (
                    <td key={c} className="p-0">
                      <button
                        type="button"
                        onClick={() => ids[0] && goToFinding(ids[0])}
                        title={tip}
                        aria-label={tip}
                        className={cn(
                          cell,
                          'rc-focusable w-full cursor-pointer transition-[outline] hover:outline-2 hover:-outline-offset-2 hover:outline-foreground',
                          sev ? cn(SEV_BG[sev], 'border-transparent text-card') : 'border-destructive/40 bg-destructive/10 text-destructive',
                        )}
                      >
                        {ids.length || '✕'}
                      </button>
                    </td>
                  )
                })}
                <td className="px-2 text-right font-mono text-xs">{total}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[0.8125rem] text-muted-foreground">{t('report.matrixHint')}</p>
    </Page>
  )
}

// ---------------------------------------------------------------- Проверка набора
export function SetTab() {
  const { t } = useTranslation()
  const { report } = useReport()
  const checks = new Map(report.set_assessment.checks.map((c) => [c.criterion, c]))
  const n = { pass: 0, fail: 0, not_applicable: 0 }
  SET_CRITERIA.forEach((c) => {
    const v = checks.get(c)?.verdict
    if (v) n[v]++
  })
  const unknown = SET_CRITERIA.length - n.pass - n.fail - n.not_applicable
  return (
    <Page>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 border bg-card px-5 py-4">
        <span className="text-[1.875rem] leading-none font-medium tracking-tight tabular-nums">
          {n.pass} <span className="text-xl text-muted-foreground">{t('report.ofTotal', { total: SET_CRITERIA.length })}</span>
        </span>
        <span className="flex-[1_1_300px] text-sm text-foreground/80">{t('report.setIntro')}</span>
        <span className="flex h-2.5 flex-[0_1_260px] gap-[3px]" aria-hidden>
          {n.pass > 0 && <span className="bg-teal" style={{ flex: n.pass }} />}
          {n.fail > 0 && <span className="bg-sev-critical" style={{ flex: n.fail }} />}
          {n.not_applicable + unknown > 0 && <span className="bg-input" style={{ flex: n.not_applicable + unknown }} />}
        </span>
        <span className="flex flex-wrap gap-3 font-mono text-[11px] text-muted-foreground">
          <span>
            ✓ {t('verdict.pass')} {n.pass}
          </span>
          <span>
            ✕ {t('verdict.fail')} {n.fail}
          </span>
          {n.not_applicable + unknown > 0 && (
            <span>
              — {t('verdict.not_applicable')} {n.not_applicable + unknown}
            </span>
          )}
        </span>
      </div>
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,360px),1fr))]">
        {SET_CRITERIA.map((c) => {
          const chk = checks.get(c)
          const v = chk?.verdict
          const tone = v === 'pass' ? 'var(--teal)' : v === 'fail' ? 'var(--sev-critical)' : 'var(--input)'
          return (
            <article key={c} className="flex flex-col gap-2.5 border bg-card py-4 pr-4 pl-5" style={{ boxShadow: `inset 3px 0 0 ${tone}` }}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex flex-col gap-0.5">
                  <h2 className="text-base font-medium">{t(`criteria.${c}.title`)}</h2>
                  <span className="font-mono text-[11px] text-muted-foreground">{CRITERION_REFS[c].join(' · ')}</span>
                </div>
                {v ? (
                  <TonePill tone={VERDICT_TONE[v]}>
                    {VERDICT_ICON[v]} {t(`verdict.${v}`)}
                  </TonePill>
                ) : (
                  <TonePill tone="muted">—</TonePill>
                )}
              </div>
              {chk?.comment && <p className="text-sm leading-relaxed">{chk.comment}</p>}
              <p className="text-[0.8125rem] leading-relaxed text-muted-foreground">{t(`criteria.${c}.description`)}</p>
              <FindingLinks ids={chk?.finding_ids} />
            </article>
          )
        })}
      </div>
    </Page>
  )
}

// ---------------------------------------------------------------- Чек-лист
const ANSWER_TONE: Record<ChecklistAnswer, 'ok' | 'bad' | 'muted'> = { yes: 'ok', no: 'bad', not_required: 'muted' }
const ANSWER_ICON: Record<ChecklistAnswer, string> = { yes: '✓', no: '✕', not_required: '—' }

export function ChecklistTab() {
  const { t } = useTranslation()
  const { report } = useReport()
  const items = report.checklist ?? []
  if (!items.length) return <EmptyState title={t('report.noChecklist')} hint={t('report.noChecklistHint')} />
  const n = { yes: 0, no: 0, not_required: 0 }
  items.forEach((i) => n[i.answer]++)
  return (
    <Page className="max-w-[1080px]">
      <div className="flex flex-wrap items-center gap-4 text-sm text-foreground/80">
        <span>{t('report.checklistIntro')}</span>
        <span className="ml-auto flex gap-3 font-mono text-xs">
          <span className="text-teal">
            ✓ {t('checklist.yes')} {n.yes}
          </span>
          <span className="text-sev-critical">
            ✕ {t('checklist.no')} {n.no}
          </span>
          <span className="text-muted-foreground">
            — {t('checklist.not_required')} {n.not_required}
          </span>
        </span>
      </div>
      <ol className="border bg-card">
        {items.map((it, i) => (
          <li key={i} className="grid grid-cols-[32px_minmax(0,1fr)] gap-x-3.5 gap-y-2 border-b px-4 py-3.5 last:border-b-0 sm:grid-cols-[40px_minmax(0,1fr)_auto] sm:px-5">
            <span className="pt-0.5 font-mono text-xs text-muted-foreground">{String(i + 1).padStart(2, '0')}</span>
            <span className="flex flex-col gap-1">
              <span className="text-[0.9375rem] font-medium">{it.question}</span>
              {(it.comment || it.finding_ids?.length) && (
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.8125rem] leading-normal text-muted-foreground">
                  {it.comment}
                  <FindingLinks ids={it.finding_ids} />
                </span>
              )}
            </span>
            <span className="col-start-2 sm:col-start-auto sm:justify-self-end">
              <TonePill tone={ANSWER_TONE[it.answer]}>
                {ANSWER_ICON[it.answer]} {t(`checklist.${it.answer}`)}
              </TonePill>
            </span>
          </li>
        ))}
      </ol>
    </Page>
  )
}

// ---------------------------------------------------------------- Паспорт прогона
export function PassportTab({ run, onExport }: { run: Run; onExport: (f: ExportFormat) => void }) {
  const { t } = useTranslation()
  const { report } = useReport()
  const p = report.passport
  const u = report.usage ?? run.usage ?? {}
  const mono = 'font-mono text-[0.8125rem]'
  const rows: [string, ReactNode][] = [
    [t('passport.document'), p.document_name],
    [t('passport.sha256'), <code className={cn(mono, 'break-all')}>{p.document_sha256}</code>],
    [t('passport.format'), report.document.format.toUpperCase()],
    [t('passport.runAt'), formatDate(p.run_at)],
    [t('passport.provider'), t(`provider.${p.provider}`, { defaultValue: p.provider })],
    [t('passport.model'), <code className={mono}>{p.model}</code>],
    [t('passport.agentVersion'), <code className={mono}>{p.agent_version}</code>],
    [t('passport.schemaVersion'), <code className={mono}>{report.schema_version ?? '—'}</code>],
    [t('passport.standards'), (p.standards ?? []).join('; ') || '—'],
    [
      t('passport.options'),
      Object.entries(run.options ?? {})
        .map(([k, v]) => `${k}: ${String(v)}`)
        .join(', ') || '—',
    ],
  ]
  const tokens = u.prompt_tokens != null || u.completion_tokens != null ? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0) : null
  const usage: [string, string][] = [
    [t('usage.calls'), formatNumber(u.llm_calls)],
    [t('run.duration'), formatDuration(u.duration_s)],
    [t('usage.promptTokens'), formatNumber(u.prompt_tokens)],
    [t('usage.completionTokens'), formatNumber(u.completion_tokens)],
    [t('passport.totalTokens'), formatNumber(tokens)],
    [t('usage.cost'), formatUsd(u.cost_usd)],
  ]
  const btn = 'h-10 rounded-none font-mono text-[0.8125rem] shadow-none'
  return (
    <Page className="grid items-start gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,380px),1fr))]">
      <Panel title={t('passport.title')}>
        <dl className="grid gap-x-4 gap-y-2.5 text-sm sm:grid-cols-[170px_minmax(0,1fr)]">
          {rows.map(([k, v]) => (
            <Fragment key={k}>
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="mb-1.5 [overflow-wrap:anywhere] sm:mb-0">{v}</dd>
            </Fragment>
          ))}
        </dl>
      </Panel>
      <div className="flex flex-col gap-4">
        <Panel title={t('usage.title')}>
          <dl className="grid grid-cols-2 gap-px border bg-border">
            {usage.map(([k, v]) => (
              <div key={k} className="flex flex-col gap-1 bg-card px-3.5 py-3">
                <dt className={EYEBROW}>{k}</dt>
                <dd className="text-xl font-medium tracking-tight tabular-nums">{v}</dd>
              </div>
            ))}
          </dl>
        </Panel>
        <Panel title={t('report.exports')}>
          <div className="flex flex-wrap gap-2">
            <Button className={btn} onClick={() => onExport('pdf')}>
              <Download />
              {t('report.downloadPdf')}
            </Button>
            {(['docx', 'md', 'json'] as ExportFormat[]).map((f) => (
              <Button key={f} variant="outline" className={cn(btn, 'font-normal')} onClick={() => onExport(f)}>
                {t(`report.exportAs.${f}`)}
              </Button>
            ))}
          </div>
        </Panel>
      </div>
    </Page>
  )
}

// ---------------------------------------------------------------- Уточняющие вопросы автору
const PRIORITY_TONE: Record<QuestionPriority, 'bad' | 'info' | 'warn'> = { blocker: 'bad', important: 'info', minor: 'warn' }
const PRIORITY_VAR: Record<QuestionPriority, string> = { blocker: 'var(--sev-critical)', important: 'var(--sev-major)', minor: 'var(--sev-minor)' }
type QFilter = 'all' | 'blocker' | 'important' | 'open'
type Answers = Record<string, { choice?: number; custom?: string }>

/** Ответы автора хранятся только в этом браузере — чтобы переслать их, есть кнопка «Скопировать ответы». */
function useAnswers(runId: string) {
  const key = `reqcheck.answers.${runId}`
  const [answers, setAnswers] = useState<Answers>(() => {
    try {
      return JSON.parse(localStorage.getItem(key) ?? '{}') as Answers
    } catch {
      return {}
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(answers))
    } catch {
      /* хранилище недоступно — ответы живут до перезагрузки */
    }
  }, [key, answers])
  return [answers, setAnswers] as const
}

export function QuestionsTab() {
  const { t } = useTranslation()
  const { report, runId } = useReport()
  const items = useMemo(() => report.questions ?? [], [report.questions])
  const [answers, setAnswers] = useAnswers(runId)
  const [filter, setFilter] = useState<QFilter>('all')
  if (!items.length) return <EmptyState title={t('questions.empty')} hint={t('questions.emptyHint')} />

  const answerOf = (id: string): string | null => {
    const a = answers[id]
    const q = items.find((x) => x.id === id)
    if (a?.choice != null && q?.options?.[a.choice] != null) return q.options[a.choice]
    return a?.custom?.trim() || null
  }
  const answered = items.filter((q) => answerOf(q.id)).length
  const prio = (p?: QuestionPriority) => p ?? 'important'
  const shown = items.filter((q) => filter === 'all' || (filter === 'open' ? !answerOf(q.id) : prio(q.priority) === filter))
  const chips: [QFilter, string, number][] = [
    ['all', t('questions.all'), items.length],
    ['blocker', t('questions.blockers'), items.filter((q) => prio(q.priority) === 'blocker').length],
    ['important', t('questions.importantPl'), items.filter((q) => prio(q.priority) === 'important').length],
    ['open', t('questions.unanswered'), items.length - answered],
  ]
  const copy = () => {
    const text = items.map((q) => `${q.id}. ${q.question}\n— ${answerOf(q.id) ?? t('questions.noAnswer')}`).join('\n\n')
    navigator.clipboard?.writeText(text).then(() => toast.success(t('common.copied')))
  }
  const set = (id: string, v: { choice?: number; custom?: string }) => setAnswers((a) => ({ ...a, [id]: v }))

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-card px-4 py-3 sm:px-5">
        <div role="group" aria-label={t('questions.filter')} className="flex flex-wrap items-center gap-2">
          {chips.map(([k, label, n]) => (
            <FilterChip key={k} pressed={filter === k} onClick={() => setFilter(k)}>
              <span>{label}</span> <span className="font-mono text-muted-foreground">{n}</span>
            </FilterChip>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3.5">
          <span className="text-[0.8125rem]" aria-live="polite">
            {t('questions.answered', { n: answered, total: items.length })}
          </span>
          <span className="block h-1.5 w-36 bg-border/70" aria-hidden>
            <span className="rc-smooth block h-1.5 bg-teal" style={{ width: `${(answered / items.length) * 100}%` }} />
          </span>
          <Button variant="outline" className="h-9 rounded-none font-mono text-xs font-normal shadow-none" onClick={copy}>
            <Copy className="size-3.5" />
            {t('questions.copyAnswers')}
          </Button>
        </div>
      </div>
      <Page className="max-w-[1000px]">
        <p className="text-sm leading-relaxed text-foreground/80">
          {t('questions.intro')} <span className="text-muted-foreground">{t('questions.localNote')}</span>
        </p>
        {shown.map((q) => {
          const p = prio(q.priority)
          const a = answers[q.id] ?? {}
          const done = !!answerOf(q.id)
          return (
            <article
              key={q.id}
              className={cn('flex flex-col gap-3 border bg-card py-4 pr-5 pl-6', done && 'border-teal/40')}
              style={{ boxShadow: `inset 3px 0 0 ${PRIORITY_VAR[p]}` }}
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 font-mono text-xs">
                <span className="font-semibold">{q.id}</span>
                <TonePill tone={PRIORITY_TONE[p]}>{t(`questions.priority.${p}`)}</TonePill>
                {q.addressee && (
                  <span className="text-muted-foreground">
                    {t('questions.addressee')}: <span className="text-foreground">{q.addressee}</span>
                  </span>
                )}
                {(q.finding_ids?.length ?? 0) > 0 && (
                  <span className="inline-flex flex-wrap items-center gap-1.5 text-muted-foreground">
                    {t('questions.findings')}: <FindingLinks ids={q.finding_ids} />
                  </span>
                )}
                <span className={cn('ml-auto', done ? 'text-teal' : 'text-muted-foreground')}>
                  {done ? `✓ ${t('questions.answerChosen')}` : t('questions.noAnswer')}
                </span>
              </div>
              <h2 className="text-[1.0625rem] leading-snug font-medium">{q.question}</h2>
              <p className="text-[0.8125rem] leading-normal text-muted-foreground">
                <span className={cn(EYEBROW, 'mr-2')}>{t('questions.why')}</span>
                {q.why}
              </p>
              <div className="flex flex-wrap gap-2">
                {(q.options?.length ?? 0) > 0 && (
                  <div role="radiogroup" aria-label={t('questions.options')} className="flex flex-wrap gap-2">
                    {q.options!.map((o, k) => (
                      <label
                        key={k}
                        className={cn(
                          'flex min-h-10 cursor-pointer items-center gap-2 border px-3 text-sm transition-colors focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-report-accent',
                          a.choice === k ? 'border-teal bg-teal/5' : 'border-input hover:border-foreground/40',
                        )}
                      >
                        <input
                          type="radio"
                          name={`${runId}-${q.id}`}
                          className="accent-[var(--teal)]"
                          checked={a.choice === k}
                          onChange={() => set(q.id, { choice: k, custom: a.custom })}
                        />
                        <span className="font-mono text-xs text-muted-foreground">{String.fromCharCode(0x430 + k)})</span>
                        <span>{o}</span>
                      </label>
                    ))}
                  </div>
                )}
                <label className="flex min-h-10 flex-[1_1_220px] items-center gap-2 border border-dashed border-input px-3 text-sm focus-within:border-foreground/50">
                  <span className="font-mono text-xs text-muted-foreground">{t('questions.custom')}</span>
                  <input
                    type="text"
                    className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground/80"
                    placeholder={t('questions.customPlaceholder')}
                    aria-label={t('questions.answerFor', { id: q.id })}
                    value={a.custom ?? ''}
                    onChange={(e) => set(q.id, { custom: e.target.value })}
                  />
                </label>
              </div>
            </article>
          )
        })}
      </Page>
    </div>
  )
}
