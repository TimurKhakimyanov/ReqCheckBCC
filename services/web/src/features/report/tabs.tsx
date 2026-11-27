import { Check, CheckCircle2, Minus, X, XCircle } from 'lucide-react'
import { Fragment, useMemo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { CheckVerdict, ChecklistAnswer, CriterionCheck, Run, Severity } from '@/api/types'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState, Table, TBody, TD, TH, THead, TR } from '@/components/ui/misc'
import { SeverityBadge } from '@/features/runs/RunBits'
import { REQUIREMENT_CRITERIA, SET_CRITERIA, SEVERITIES, SEVERITY_RANK, CRITERION_REFS } from '@/shared/criteria'
import { formatDate, formatDuration, formatNumber, formatUsd } from '@/shared/format'
import { cn } from '@/shared/utils'
import { useReport } from './context'
import { SEV_DOT } from './FindingsPanel'

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
            <button key={i} type="button" className="font-mono font-medium text-primary hover:underline" onClick={() => goToFinding(p)}>
              {p}
            </button>
          )
        if (p.startsWith('R-'))
          return (
            <button key={i} type="button" className="font-mono font-medium text-primary hover:underline" onClick={() => goToRequirement(p)}>
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
            className="inline-flex items-center gap-1 rounded border px-1.5 font-mono text-xs hover:bg-muted"
            title={f?.title}
          >
            {f && <span className={cn('size-1.5 rounded-full', SEV_DOT[f.severity])} />}
            {id}
          </button>
        )
      })}
    </span>
  )
}

function Verdict({ v }: { v: CheckVerdict }) {
  const { t } = useTranslation()
  if (v === 'pass')
    return (
      <Badge variant="success">
        <Check />
        {t('verdict.pass')}
      </Badge>
    )
  if (v === 'fail')
    return (
      <Badge variant="destructive">
        <X />
        {t('verdict.fail')}
      </Badge>
    )
  return (
    <Badge variant="secondary">
      <Minus />
      {t('verdict.not_applicable')}
    </Badge>
  )
}

function Section({ title, children, className }: { title: ReactNode; children: ReactNode; className?: string }) {
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------- Сводка и итог
export function SummaryTab() {
  const { t } = useTranslation()
  const { report } = useReport()
  const { conclusion: c, summary: s } = report
  const byCriterion = useMemo(() => {
    const m = new Map<string, number>()
    report.findings.forEach((f) => m.set(f.criterion, (m.get(f.criterion) ?? 0) + 1))
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [report.findings])
  const max = Math.max(1, ...byCriterion.map(([, n]) => n))

  const Ready = ({ ok, label }: { ok: boolean; label: string }) => (
    <div className={cn('flex items-center gap-3 rounded-lg border p-4', ok ? 'border-success/40 bg-success/5' : 'border-destructive/40 bg-destructive/5')}>
      {ok ? <CheckCircle2 className="size-7 shrink-0 text-success" /> : <XCircle className="size-7 shrink-0 text-destructive" />}
      <div>
        <div className="text-sm text-muted-foreground">{label}</div>
        <div className="text-lg font-semibold">{ok ? t('report.yes') : t('report.no')}</div>
      </div>
    </div>
  )

  return (
    <div className="grid gap-4 p-4 lg:grid-cols-3">
      <div className="grid gap-4 lg:col-span-2">
        <div className="grid gap-3 sm:grid-cols-2">
          <Ready ok={c.ready_for_development} label={t('report.readyForDev')} />
          <Ready ok={c.ready_for_testing} label={t('report.readyForTest')} />
        </div>
        <Section title={t('report.rationale')}>
          <p className="leading-relaxed">
            <Linkified text={c.rationale} />
          </p>
        </Section>
        <Section title={t('report.topFixes')}>
          {c.top_fixes.length ? (
            <ol className="grid gap-2">
              {c.top_fixes.map((fix, i) => (
                <li key={i} className="flex gap-3">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
                    {i + 1}
                  </span>
                  <span className="pt-0.5">
                    <Linkified text={fix} />
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-muted-foreground">{t('report.nothingToFix')}</p>
          )}
        </Section>
      </div>
      <div className="grid content-start gap-4">
        <Section title={t('report.numbers')}>
          <dl className="grid grid-cols-2 gap-3">
            <div>
              <dt className="text-xs text-muted-foreground">{t('report.requirementsTotal')}</dt>
              <dd className="text-2xl font-semibold tabular-nums">{s.requirements_total}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t('report.findingsTotal')}</dt>
              <dd className="text-2xl font-semibold tabular-nums">{s.findings_total}</dd>
            </div>
          </dl>
          <div className="mt-4 grid gap-2">
            {SEVERITIES.map((sev) => (
              <div key={sev} className="flex items-center justify-between">
                <SeverityBadge severity={sev} />
                <span className="font-semibold tabular-nums">{s.by_severity[sev] ?? 0}</span>
              </div>
            ))}
          </div>
          {s.critical_finding_ids.length > 0 && (
            <div className="mt-4 text-sm">
              <div className="mb-1 text-xs text-muted-foreground">{t('report.criticalIds')}</div>
              <FindingLinks ids={s.critical_finding_ids} />
            </div>
          )}
        </Section>
        <Section title={t('report.byCriterion')}>
          <div className="grid gap-2">
            {byCriterion.map(([crit, n]) => (
              <div key={crit} className="grid gap-1 text-sm">
                <div className="flex justify-between gap-2">
                  <span className="truncate">{t(`criteria.${crit}.title`)}</span>
                  <span className="tabular-nums text-muted-foreground">{n}</span>
                </div>
                <div className="h-1.5 rounded-full bg-muted">
                  <div className="h-full rounded-full bg-primary" style={{ width: `${(n / max) * 100}%` }} />
                </div>
              </div>
            ))}
            {!byCriterion.length && <p className="text-sm text-muted-foreground">{t('report.noFindings')}</p>}
          </div>
        </Section>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- Нарезка требований
export function RequirementsTab() {
  const { t } = useTranslation()
  const { report, goToRequirement, showRequirementFindings } = useReport()
  const findingsPerReq = useMemo(() => {
    const m: Record<string, number> = {}
    report.findings.forEach((f) => f.requirement_ids?.forEach((r) => (m[r] = (m[r] ?? 0) + 1)))
    return m
  }, [report.findings])

  if (!report.requirements.length) return <EmptyState title={t('report.noRequirements')} />
  return (
    <div className="p-4">
      <Card>
        <Table>
          <THead>
            <TR>
              <TH>ID</TH>
              <TH>{t('report.sourceId')}</TH>
              <TH>{t('report.kind')}</TH>
              <TH className="min-w-72">{t('report.reqSummary')}</TH>
              <TH>{t('report.section')}</TH>
              <TH>{t('documents.findings')}</TH>
            </TR>
          </THead>
          <TBody>
            {report.requirements.map((r) => (
              <TR key={r.id} className={cn(r.parent_id && 'bg-muted/30')}>
                <TD className="whitespace-nowrap">
                  <button type="button" className="font-mono font-medium text-primary hover:underline" onClick={() => goToRequirement(r.id)}>
                    {r.parent_id ? '↳ ' : ''}
                    {r.id}
                  </button>
                </TD>
                <TD className="font-mono text-xs">{r.source_id ?? '—'}</TD>
                <TD>
                  <Badge variant="outline">{t(`kind.${r.kind}`)}</Badge>
                </TD>
                <TD>
                  <div>{r.summary}</div>
                  <div className="mt-1 text-xs text-muted-foreground italic">«{r.location.quote}»</div>
                </TD>
                <TD className="text-xs text-muted-foreground">{r.location.section}</TD>
                <TD>
                  {findingsPerReq[r.id] ? (
                    <button type="button" className="text-primary hover:underline" onClick={() => showRequirementFindings(r.id)}>
                      {findingsPerReq[r.id]}
                    </button>
                  ) : (
                    <span className="text-muted-foreground">0</span>
                  )}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Card>
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

  const failCls: Record<Severity, string> = {
    critical: 'bg-sev-critical-bg text-sev-critical',
    major: 'bg-sev-major-bg text-sev-major',
    minor: 'bg-sev-minor-bg text-sev-minor',
  }

  return (
    <div className="p-4">
      <Card className="overflow-hidden">
        <Table className="border-collapse">
          <THead>
            <TR>
              <TH className="sticky left-0 z-10 bg-card">{t('report.requirement')}</TH>
              {REQUIREMENT_CRITERIA.map((c, i) => (
                <TH key={c} className="px-1 text-center" title={`${t(`criteria.${c}.title`)} — ${CRITERION_REFS[c].join(', ')}`}>
                  <span className="inline-block max-w-20 truncate align-bottom">{t(`criteria.${c}.short`)}</span>
                  <span className="sr-only">{i}</span>
                </TH>
              ))}
            </TR>
          </THead>
          <TBody>
            {report.requirements.map((r) => (
              <TR key={r.id}>
                <TD className="sticky left-0 z-10 bg-card whitespace-nowrap">
                  <button type="button" className="font-mono text-xs font-medium text-primary hover:underline" onClick={() => goToRequirement(r.id)} title={r.summary}>
                    {r.id}
                  </button>
                </TD>
                {REQUIREMENT_CRITERIA.map((c) => {
                  const chk = byReq[r.id]?.[c]
                  if (!chk) return <TD key={c} className="text-center text-muted-foreground">·</TD>
                  const sev = chk.verdict === 'fail' ? worst(chk.finding_ids) : null
                  return (
                    <TD key={c} className="p-1 text-center">
                      {chk.verdict === 'fail' ? (
                        <button
                          type="button"
                          onClick={() => chk.finding_ids?.[0] && goToFinding(chk.finding_ids[0])}
                          title={[chk.comment, chk.finding_ids?.join(', ')].filter(Boolean).join(' — ')}
                          className={cn(
                            'inline-flex h-7 min-w-9 items-center justify-center rounded px-1 font-mono text-[0.7rem] font-semibold',
                            sev ? failCls[sev] : 'bg-destructive/15 text-destructive',
                          )}
                        >
                          {chk.finding_ids?.length ? chk.finding_ids.join(' ') : <X className="size-4" />}
                        </button>
                      ) : chk.verdict === 'pass' ? (
                        <Check className="mx-auto size-4 text-success" aria-label={t('verdict.pass')} />
                      ) : (
                        <Minus className="mx-auto size-4 text-muted-foreground" aria-label={t('verdict.not_applicable')} />
                      )}
                    </TD>
                  )
                })}
              </TR>
            ))}
          </TBody>
        </Table>
      </Card>
      <p className="mt-3 text-xs text-muted-foreground">{t('report.matrixHint')}</p>
    </div>
  )
}

// ---------------------------------------------------------------- Проверка набора
export function SetTab() {
  const { t } = useTranslation()
  const { report } = useReport()
  const checks = new Map(report.set_assessment.checks.map((c) => [c.criterion, c]))
  return (
    <div className="grid gap-3 p-4 md:grid-cols-2">
      {SET_CRITERIA.map((c) => {
        const chk = checks.get(c)
        return (
          <Card key={c} className={cn(chk?.verdict === 'fail' && 'border-destructive/40')}>
            <CardContent className="grid gap-2 pt-5">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-medium">{t(`criteria.${c}.title`)}</div>
                  <div className="text-xs text-muted-foreground">{CRITERION_REFS[c].join(' · ')}</div>
                </div>
                {chk ? <Verdict v={chk.verdict} /> : <Badge variant="secondary">—</Badge>}
              </div>
              <p className="text-sm text-muted-foreground">{t(`criteria.${c}.description`)}</p>
              {chk?.comment && <p className="text-sm">{chk.comment}</p>}
              <FindingLinks ids={chk?.finding_ids} />
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------- Чек-лист
export function ChecklistTab() {
  const { t } = useTranslation()
  const { report } = useReport()
  const items = report.checklist ?? []
  const variant: Record<ChecklistAnswer, 'success' | 'destructive' | 'secondary'> = {
    yes: 'success',
    no: 'destructive',
    not_required: 'secondary',
  }
  if (!items.length) return <EmptyState title={t('report.noChecklist')} hint={t('report.noChecklistHint')} />
  return (
    <div className="p-4">
      <Card>
        <Table>
          <THead>
            <TR>
              <TH className="w-8">#</TH>
              <TH>{t('report.question')}</TH>
              <TH>{t('report.answer')}</TH>
              <TH>{t('report.comment')}</TH>
              <TH>{t('documents.findings')}</TH>
            </TR>
          </THead>
          <TBody>
            {items.map((it, i) => (
              <TR key={i}>
                <TD className="text-muted-foreground">{i + 1}</TD>
                <TD className="font-medium">{it.question}</TD>
                <TD>
                  <Badge variant={variant[it.answer]}>{t(`checklist.${it.answer}`)}</Badge>
                </TD>
                <TD className="text-muted-foreground">{it.comment}</TD>
                <TD>
                  <FindingLinks ids={it.finding_ids} />
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------- Паспорт прогона
export function PassportTab({ run }: { run: Run }) {
  const { t } = useTranslation()
  const { report } = useReport()
  const p = report.passport
  const u = report.usage ?? run.usage ?? {}
  const rows: [string, ReactNode][] = [
    [t('passport.document'), p.document_name],
    [t('passport.sha256'), <code className="text-xs break-all">{p.document_sha256}</code>],
    [t('passport.format'), report.document.format.toUpperCase()],
    [t('passport.runAt'), formatDate(p.run_at)],
    [t('passport.provider'), t(`provider.${p.provider}`, { defaultValue: p.provider })],
    [t('passport.model'), <code>{p.model}</code>],
    [t('passport.agentVersion'), <code>{p.agent_version}</code>],
    [t('passport.schemaVersion'), report.schema_version ?? '—'],
    [t('passport.standards'), (p.standards ?? []).join('; ')],
    [
      t('passport.options'),
      Object.entries(run.options ?? {})
        .map(([k, v]) => `${k}: ${String(v)}`)
        .join(', ') || '—',
    ],
  ]
  const usage: [string, string][] = [
    [t('usage.calls'), formatNumber(u.llm_calls)],
    [t('usage.promptTokens'), formatNumber(u.prompt_tokens)],
    [t('usage.completionTokens'), formatNumber(u.completion_tokens)],
    [t('usage.cost'), formatUsd(u.cost_usd)],
    [t('run.duration'), formatDuration(u.duration_s)],
  ]
  return (
    <div className="grid gap-4 p-4 lg:grid-cols-3">
      <Section title={t('passport.title')} className="lg:col-span-2">
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-[12rem_1fr]">
          {rows.map(([k, v]) => (
            <Fragment key={k}>
              <dt className="text-sm text-muted-foreground">{k}</dt>
              <dd className="text-sm">{v}</dd>
            </Fragment>
          ))}
        </dl>
      </Section>
      <Section title={t('usage.title')}>
        <dl className="grid gap-3">
          {usage.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-2">
              <dt className="text-sm text-muted-foreground">{k}</dt>
              <dd className="text-sm font-medium tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
      </Section>
    </div>
  )
}
