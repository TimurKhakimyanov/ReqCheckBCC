import { Check, Copy, Minus, X } from 'lucide-react'
import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { CheckVerdict, ChecklistAnswer, CriterionCheck, QuestionPriority, Run, Severity } from '@/api/types'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState, Table, TBody, TD, TH, THead, TR } from '@/components/ui/misc'
import { REQUIREMENT_CRITERIA, SET_CRITERIA, SEVERITY_RANK, CRITERION_REFS } from '@/shared/criteria'
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
    partial: 'secondary',
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

// ---------------------------------------------------------------- Уточняющие вопросы автору
const PRIORITY_TONE: Record<QuestionPriority, string> = {
  blocker: 'bg-sev-critical-bg text-sev-critical',
  important: 'bg-sev-major-bg text-sev-major',
  minor: 'bg-secondary text-muted-foreground',
}

type Answers = Record<string, { choice?: number; custom?: string }>

/** Ответы автора хранятся в этом браузере; чтобы переслать их, есть кнопка «Скопировать ответы». */
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
  if (!items.length) return <EmptyState title={t('questions.empty')} hint={t('questions.emptyHint')} />

  const answerOf = (id: string): string | null => {
    const a = answers[id]
    const q = items.find((x) => x.id === id)
    if (a?.choice != null && q?.options?.[a.choice] != null) return q.options[a.choice]
    return a?.custom?.trim() || null
  }
  const answered = items.filter((q) => answerOf(q.id)).length
  const copy = () => {
    const text = items.map((q) => `${q.id}. ${q.question}\n— ${answerOf(q.id) ?? t('questions.noAnswer')}`).join('\n\n')
    navigator.clipboard?.writeText(text).then(() => toast.success(t('common.copied')))
  }
  const set = (id: string, v: { choice?: number; custom?: string }) => setAnswers((a) => ({ ...a, [id]: v }))

  return (
    <div className="grid gap-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-3xl text-sm text-muted-foreground">
          {t('questions.intro')} {t('questions.localNote')}
        </p>
        <div className="flex items-center gap-3">
          <span className="text-sm" aria-live="polite">
            {t('questions.answered', { n: answered, total: items.length })}
          </span>
          <Button variant="outline" size="sm" onClick={copy}>
            <Copy />
            {t('questions.copyAnswers')}
          </Button>
        </div>
      </div>
      {items.map((q, i) => {
        const prio = q.priority ?? 'important'
        const a = answers[q.id] ?? {}
        const done = !!answerOf(q.id)
        return (
          <article key={q.id} className="rc-fade grid gap-3 rounded-2xl bg-card shadow-card p-5" style={{ animationDelay: `${Math.min(i, 10) * 0.05}s` }}>
            <div className="flex flex-wrap items-center gap-3 font-mono text-xs">
              <span className="text-muted-foreground">{q.id}</span>
              <span className={cn('rounded-full px-2.5 py-0.5 font-sans font-medium', PRIORITY_TONE[prio])}>{t(`questions.priority.${prio}`)}</span>
              <span className="text-muted-foreground">
                {t('questions.addressee')}: <span className="text-foreground">{q.addressee}</span>
              </span>
              <span className={cn('ml-auto font-sans', done ? 'text-success' : 'text-muted-foreground')}>
                {done ? `✓ ${t('questions.answerChosen')}` : t('questions.noAnswer')}
              </span>
            </div>
            <h3 className="text-[1.0625rem] leading-snug font-medium">{q.question}</h3>
            <p className="text-sm text-muted-foreground">
              <span className="label-mono mr-2">{t('questions.why')}</span>
              {q.why}
            </p>
            <div className="flex flex-wrap gap-2">
              {(q.options?.length ?? 0) > 0 && (
                <div role="radiogroup" aria-label={t('questions.options')} className="flex flex-wrap gap-2">
                  {q.options!.map((o, k) => (
                    <label
                      key={k}
                      className={cn(
                        'flex cursor-pointer items-center gap-2 rounded-xl px-3.5 py-2 text-sm transition-colors',
                        a.choice === k ? 'bg-success/15 ring-1 ring-success' : 'bg-secondary hover:bg-accent',
                      )}
                    >
                      <input
                        type="radio"
                        name={`${runId}-${q.id}`}
                        className="accent-[var(--success)]"
                        checked={a.choice === k}
                        onChange={() => set(q.id, { choice: k, custom: a.custom })}
                      />
                      <span className="font-mono text-xs text-muted-foreground">{String.fromCharCode(0x430 + k)})</span>
                      {o}
                    </label>
                  ))}
                </div>
              )}
              <label className="flex min-w-56 flex-1 items-center gap-2 rounded-xl border border-dashed px-3.5 py-2 text-sm">
                <span className="font-mono text-xs text-muted-foreground">{t('questions.custom')}</span>
                <input
                  type="text"
                  className="min-w-0 flex-1 bg-transparent outline-none"
                  placeholder={t('questions.customPlaceholder')}
                  value={a.custom ?? ''}
                  onChange={(e) => set(q.id, { choice: e.target.value ? undefined : a.choice, custom: e.target.value })}
                />
              </label>
            </div>
            {(q.finding_ids?.length ?? 0) > 0 && (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="label-mono">{t('questions.findings')}</span>
                <FindingLinks ids={q.finding_ids} />
              </div>
            )}
          </article>
        )
      })}
    </div>
  )
}
