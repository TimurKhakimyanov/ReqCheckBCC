import { useQuery } from '@tanstack/react-query'
import {
  ArrowLeft,
  BarChart3,
  Check,
  ChevronDown,
  CircleHelp,
  Download,
  FileBadge,
  Grid3x3,
  Layers,
  List,
  ListChecks,
  MessageSquareText,
  RotateCw,
  TriangleAlert,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useCallback, useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { api } from '@/api/client'
import type { ExportFormat, Finding, FindingReview, Run } from '@/api/types'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { ErrorNote, Skeleton } from '@/components/ui/misc'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ChatPanel } from '@/features/chat/ChatPanel'
import { LaunchRunDialog } from '@/features/runs/LaunchRunDialog'
import { downloadFile, formatDate } from '@/shared/format'
import { cn } from '@/shared/utils'
import { ReportContext, useReport, type ReportCtx, type ReportTab, type Selection } from './context'
import { EMPTY_FILTERS, filterFindings, type FindingFilters } from './filters'
import { FindingsWorkspace, type Grouping } from './FindingsPanel'
import { makeOffsetMapper } from './highlight'
import { SummaryTab } from './SummaryTab'
import { ChecklistTab, MatrixTab, PassportTab, QuestionsTab, RequirementsTab, SetTab } from './tabs'
import { EYEBROW } from './ui'

const TABS: ReportTab[] = ['findings', 'summary', 'questions', 'requirements', 'matrix', 'set', 'checklist', 'passport']
const OTHER_EXPORTS: ExportFormat[] = ['docx', 'md', 'json']
const TAB_ICONS: Record<ReportTab, LucideIcon> = {
  findings: TriangleAlert,
  summary: BarChart3,
  questions: CircleHelp,
  requirements: List,
  matrix: Grid3x3,
  set: Layers,
  checklist: ListChecks,
  passport: FileBadge,
}

export function ReportView({ run }: { run: Run }) {
  const [params, setParams] = useSearchParams()
  const tab = (TABS.includes(params.get('tab') as ReportTab) ? params.get('tab') : 'findings') as ReportTab
  const setTab = useCallback(
    (v: ReportTab) =>
      setParams(
        (p) => {
          const n = new URLSearchParams(p)
          if (v === 'findings') n.delete('tab')
          else n.set('tab', v)
          return n
        },
        { replace: true },
      ),
    [setParams],
  )
  const [chatOpen, setChatOpen] = useState(false)
  const [relaunch, setRelaunch] = useState(false)
  const [railOpen, setRailOpen] = useState(false)
  const [filters, setFilters] = useState<FindingFilters>(EMPTY_FILTERS)
  const [group, setGroup] = useState<Grouping>('severity')
  const [selection, setSelection] = useState<Selection>({ findingId: params.get('finding'), locIndex: 0, nonce: 1, origin: 'other' })
  const [focusReq, setFocusReq] = useState<{ start: number; end: number } | null>(null)

  const report = useQuery({ queryKey: ['report', run.id], queryFn: () => api.report(run.id), staleTime: Infinity })
  const findingsQ = useQuery({ queryKey: ['findings', run.id], queryFn: () => api.findings(run.id) })

  const reviews = useMemo(() => {
    const m: Record<string, FindingReview> = {}
    findingsQ.data?.forEach((x) => (m[x.finding.id] = x.review))
    return m
  }, [findingsQ.data])

  const findingsById = useMemo(() => {
    const m: Record<string, Finding> = {}
    report.data?.findings.forEach((f) => (m[f.id] = f))
    return m
  }, [report.data])

  const visible = useMemo(
    () => (report.data ? filterFindings(report.data.findings, reviews, filters) : []),
    [report.data, reviews, filters],
  )

  const select = useCallback<ReportCtx['select']>((findingId, opts = {}) => {
    setFocusReq(null)
    setSelection((s) => ({ findingId, locIndex: opts.locIndex ?? 0, nonce: s.nonce + 1, origin: opts.origin ?? 'other' }))
  }, [])

  const ctx: ReportCtx | null = report.data
    ? {
        runId: run.id,
        report: report.data,
        findingsById,
        reviews,
        selection,
        select,
        setTab,
        goToFinding: (id) => {
          setTab('findings')
          // выбранный дефект должен быть виден при текущих фильтрах
          if (!visible.some((f) => f.id === id)) setFilters(EMPTY_FILTERS)
          select(id, { origin: 'other' })
        },
        goToRequirement: (reqId) => {
          const r = report.data!.requirements.find((x) => x.id === reqId)
          if (!r) return
          setTab('findings')
          const text = report.data!.document.text
          const map = makeOffsetMapper(text)
          let range: { start: number; end: number } | null = null
          if (r.location.char_start != null && r.location.char_end != null)
            range = { start: map(r.location.char_start), end: map(r.location.char_end) }
          else {
            const i = text.indexOf(r.location.quote)
            if (i >= 0) range = { start: i, end: i + r.location.quote.length }
          }
          setFocusReq(range)
        },
        showRequirementFindings: (reqId) => {
          setTab('findings')
          setFilters({ ...EMPTY_FILTERS, requirement: reqId })
        },
      }
    : null

  if (report.error) return <div className="p-6"><ErrorNote error={report.error} /></div>
  if (!ctx)
    return (
      <div className="grid gap-3 p-6">
        <Skeleton className="h-10 w-1/2" />
        <Skeleton className="h-96" />
      </div>
    )
  const r = ctx.report

  const exportReport = (fmt: ExportFormat) =>
    downloadFile(api.reportExportUrl(run.id, fmt), `${r.passport.document_name}.report.${fmt}`).catch((e) => toast.error(e.message))

  return (
    <ReportContext.Provider value={ctx}>
      <div className="h-full overflow-y-auto p-3 sm:px-4 lg:overflow-hidden">
        <div className="mx-auto flex min-h-full max-w-[1440px] flex-col border bg-card lg:h-full lg:min-h-0">
          <ReportHeader
            run={run}
            onExport={exportReport}
            onRerun={() => setRelaunch(true)}
            chatOpen={chatOpen}
            onToggleChat={() => setChatOpen((v) => !v)}
          />
          <div className="flex min-h-0 flex-1">
            <Tabs
              value={tab}
              onValueChange={(v) => setTab(v as ReportTab)}
              orientation="vertical"
              className="flex min-h-0 min-w-0 flex-1 flex-col lg:flex-row"
            >
              <ReportRail tab={tab} open={railOpen} setOpen={setRailOpen} />
              <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
                <TabsContent value="findings" className="flex min-h-0 flex-1 flex-col">
                  <FindingsWorkspace visible={visible} filters={filters} setFilters={setFilters} group={group} setGroup={setGroup} focusRange={focusReq} />
                </TabsContent>
                {TABS.filter((v) => v !== 'findings').map((v) => (
                  <TabsContent key={v} value={v} className="min-h-0 flex-1 lg:overflow-y-auto">
                    {v === 'summary' && <SummaryTab run={run} />}
                    {v === 'requirements' && <RequirementsTab />}
                    {v === 'matrix' && <MatrixTab />}
                    {v === 'set' && <SetTab />}
                    {v === 'questions' && <QuestionsTab />}
                    {v === 'checklist' && <ChecklistTab />}
                    {v === 'passport' && <PassportTab run={run} onExport={exportReport} />}
                  </TabsContent>
                ))}
              </div>
            </Tabs>
            <aside
              className={cn(
                'min-h-0 shrink-0 overflow-hidden bg-card',
                chatOpen ? 'fixed inset-0 z-30 w-full sm:static sm:w-[380px] sm:border-l xl:w-[420px]' : 'hidden',
              )}
            >
              {chatOpen && <ChatPanel runId={run.id} onClose={() => setChatOpen(false)} />}
            </aside>
          </div>
        </div>
      </div>
      <LaunchRunDialog
        document={{
          id: run.document_id,
          name: run.document_name,
          format: r.document.format,
          size_bytes: 0,
          sha256: r.passport.document_sha256,
          created_at: run.created_at,
          runs_count: 0,
        }}
        open={relaunch}
        onOpenChange={setRelaunch}
      />
    </ReportContext.Provider>
  )
}

// ---------------------------------------------------------------- Шапка отчёта
function ReportHeader({
  run,
  onExport,
  onRerun,
  chatOpen,
  onToggleChat,
}: {
  run: Run
  onExport: (f: ExportFormat) => void
  onRerun: () => void
  chatOpen: boolean
  onToggleChat: () => void
}) {
  const { t } = useTranslation()
  const { report: r } = useReport()
  const p = r.passport
  const ready = r.conclusion.ready_for_development
  const crit = r.summary.by_severity.critical ?? 0
  const questions = r.questions ?? []
  const blockers = questions.filter((q) => q.priority === 'blocker').length
  const parts = [crit ? t('report.criticalCount', { count: crit }) : null, blockers ? t('report.blockerCount', { count: blockers }) : null].filter(Boolean)
  const reason = ready ? t('report.verdictReady') : parts.length ? t('report.verdictFirst', { items: parts.join(', ') }) : r.conclusion.rationale
  const meta = [
    formatDate(p.run_at),
    t(`provider.${p.provider}`, { defaultValue: p.provider }),
    p.model,
    t('report.reqCount', { count: r.summary.requirements_total }),
    t('report.findingCount', { count: r.summary.findings_total }),
    questions.length ? t('report.questionCount', { count: questions.length }) : null,
  ].filter(Boolean)

  const btn = 'h-10 rounded-none font-mono text-[0.8125rem] font-medium shadow-none'
  return (
    <header className="flex flex-wrap items-center justify-between gap-x-7 gap-y-4 border-b px-4 py-4 sm:px-6">
      <div className="flex min-w-0 flex-[1_1_320px] items-center gap-3.5">
        <Link
          to={`/documents/${run.document_id}`}
          className="rc-focusable flex size-9 shrink-0 items-center justify-center border text-foreground transition-colors hover:bg-secondary"
          aria-label={t('report.backToDocument')}
          title={t('report.backToDocument')}
        >
          <ArrowLeft className="size-4" />
        </Link>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className={EYEBROW}>
            {t('report.eyebrow')} · {run.id.slice(0, 8)}
          </span>
          <h1 className="truncate text-xl font-medium tracking-tight" title={p.document_name}>
            {p.document_name}
          </h1>
          <span className="text-xs text-muted-foreground">{meta.join(' · ')}</span>
        </div>
      </div>

      <div
        className={cn('flex max-w-full items-center gap-3.5 border px-3.5 py-2', ready ? 'border-teal/40 bg-teal/5' : 'border-sev-critical/35 bg-sev-critical-bg')}
        role="status"
      >
        <span
          className={cn(
            'inline-flex size-[26px] shrink-0 items-center justify-center border-[1.5px]',
            ready ? 'border-teal text-teal' : 'border-sev-critical text-sev-critical',
          )}
        >
          {ready ? <Check className="size-3.5" strokeWidth={2.5} /> : <X className="size-3.5" strokeWidth={2.5} />}
        </span>
        <span className="flex min-w-0 flex-col">
          <span className={cn('text-sm font-semibold', ready ? 'text-teal' : 'text-sev-critical')}>{ready ? t('report.readyYes') : t('report.readyNo')}</span>
          <span className="line-clamp-2 max-w-[28rem] text-xs text-muted-foreground" title={reason}>
            {reason}
          </span>
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button className={btn} onClick={() => onExport('pdf')} data-testid="download-pdf">
          <Download />
          {t('report.downloadPdf')}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className={cn(btn, 'gap-1.5 px-3 font-normal')} aria-label={t('report.otherFormats')} title={t('report.otherFormats')}>
              DOCX · MD · JSON
              <ChevronDown className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="rounded-none border shadow-none">
            {OTHER_EXPORTS.map((f) => (
              <DropdownMenuItem key={f} className="rounded-none" onSelect={() => onExport(f)}>
                {t(`report.exportAs.${f}`)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant="outline" className={cn(btn, 'font-normal')} onClick={onRerun}>
          <RotateCw className="size-3.5" />
          {t('report.rerun')}
        </Button>
        <Button variant={chatOpen ? 'secondary' : 'outline'} className={cn(btn, 'font-normal', chatOpen && 'border border-foreground')} onClick={onToggleChat} aria-pressed={chatOpen}>
          <MessageSquareText className="size-3.5" />
          {t('chat.open')}
        </Button>
      </div>
    </header>
  )
}

// ---------------------------------------------------------------- Меню разделов слева
function ReportRail({ tab, open, setOpen }: { tab: ReportTab; open: boolean; setOpen: (v: boolean) => void }) {
  const { t } = useTranslation()
  const { report: r, reviews } = useReport()
  const listId = useId()

  const setChecks = r.set_assessment.checks
  const counts: Partial<Record<ReportTab, string>> = {
    findings: String(r.findings.length),
    questions: r.questions?.length ? String(r.questions.length) : undefined,
    requirements: String(r.requirements.length),
    set: setChecks.length ? `${setChecks.filter((c) => c.verdict === 'pass').length}/${setChecks.length}` : undefined,
    checklist: r.checklist?.length ? `${r.checklist.filter((c) => c.answer === 'yes').length}/${r.checklist.length}` : undefined,
  }

  const reviewed = { accepted: 0, false_positive: 0, fixed: 0 }
  r.findings.forEach((f) => {
    const s = reviews[f.id]?.status
    if (s && s in reviewed) reviewed[s as keyof typeof reviewed]++
  })
  const done = reviewed.accepted + reviewed.false_positive + reviewed.fixed
  const pct = (n: number) => `${r.findings.length ? (n / r.findings.length) * 100 : 0}%`
  const CurIcon = TAB_ICONS[tab]

  return (
    <aside className="shrink-0 border-b bg-sidebar lg:w-[220px] lg:overflow-y-auto lg:border-r lg:border-b-0">
      <button
        type="button"
        className="rc-focusable flex min-h-12 w-full cursor-pointer items-center gap-2.5 px-4 text-left text-sm lg:hidden"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen(!open)}
      >
        <span className={EYEBROW}>{t('report.sections')}</span>
        <CurIcon className="size-4 text-muted-foreground" aria-hidden />
        <span className="flex-1 font-medium">{t(`report.tabs.${tab}`)}</span>
        <ChevronDown className={cn('size-4 transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      <div id={listId} className={cn('flex-col gap-4 px-3 pb-4 lg:flex lg:pt-4', open ? 'flex' : 'hidden')}>
        <div className="flex flex-col gap-1">
          <span className={cn(EYEBROW, 'hidden px-2.5 pb-1.5 lg:block')}>{t('report.sections')}</span>
          <TabsList aria-label={t('report.sectionsMenu')} className="flex flex-col flex-nowrap items-stretch gap-0.5 rounded-none bg-transparent p-0">
            {TABS.map((v) => {
              const Icon = TAB_ICONS[v]
              return (
                <TabsTrigger
                  key={v}
                  value={v}
                  onClick={() => setOpen(false)}
                  className="h-10 justify-start gap-2.5 rounded-none px-2.5 text-sm font-normal text-foreground/80 hover:bg-secondary focus-visible:ring-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-report-accent data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-[inset_2px_0_0_var(--report-accent),0_0_0_1px_var(--border)]"
                >
                  <Icon className="size-4 shrink-0" strokeWidth={1.8} aria-hidden />
                  <span className="flex-1 text-left">{t(`report.tabs.${v}`)}</span>
                  {counts[v] && <span className="font-mono text-xs text-muted-foreground tabular-nums">{counts[v]}</span>}
                </TabsTrigger>
              )
            })}
          </TabsList>
        </div>

        <div className="flex flex-col gap-2.5 border-t px-2.5 pt-3.5">
          <span className={EYEBROW}>{t('report.reviewProgress')}</span>
          <span className="text-[0.8125rem]">
            {t('report.reviewedOf', { done, total: r.findings.length })}
          </span>
          <span className="flex h-1.5 gap-0.5 bg-border/70" aria-hidden>
            <span className="rc-smooth bg-teal" style={{ width: pct(reviewed.accepted) }} />
            <span className="rc-smooth bg-muted-foreground" style={{ width: pct(reviewed.false_positive) }} />
            <span className="rc-smooth bg-sev-major" style={{ width: pct(reviewed.fixed) }} />
          </span>
          <span className="grid gap-1 font-mono text-[11px] text-muted-foreground">
            <span>
              <span className="mr-1.5 inline-block size-2 bg-teal" />
              {t('review.accepted')} {reviewed.accepted}
            </span>
            <span>
              <span className="mr-1.5 inline-block size-2 bg-muted-foreground" />
              {t('review.false_positive')} {reviewed.false_positive}
            </span>
            <span>
              <span className="mr-1.5 inline-block size-2 bg-sev-major" />
              {t('review.fixed')} {reviewed.fixed}
            </span>
          </span>
        </div>
      </div>
    </aside>
  )
}
