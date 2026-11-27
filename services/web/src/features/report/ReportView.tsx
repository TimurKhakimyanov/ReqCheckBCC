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
  Play,
  TriangleAlert,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
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
import { ReadinessBadge } from '@/features/runs/RunBits'
import { SEVERITIES } from '@/shared/criteria'
import { downloadFile, formatDate } from '@/shared/format'
import { cn } from '@/shared/utils'
import { ReportContext, type ReportCtx, type ReportTab, type Selection } from './context'
import { DocumentViewer } from './DocumentViewer'
import { EMPTY_FILTERS, filterFindings, type FindingFilters } from './filters'
import { FindingsPanel, SEV_DOT } from './FindingsPanel'
import { SummaryTab } from './SummaryTab'
import { ChecklistTab, MatrixTab, PassportTab, QuestionsTab, RequirementsTab, SetTab } from './tabs'
import { makeOffsetMapper } from './highlight'

const TABS: ReportTab[] = ['findings', 'summary', 'questions', 'requirements', 'matrix', 'set', 'checklist', 'passport']
const EXPORTS: ExportFormat[] = ['pdf', 'docx', 'md', 'json']
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
  const { t } = useTranslation()
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
  const [filters, setFilters] = useState<FindingFilters>(EMPTY_FILTERS)
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
        run,
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

  const reviewed = { accepted: 0, false_positive: 0, fixed: 0 }
  Object.values(reviews).forEach((x) => {
    if (x.status in reviewed) reviewed[x.status as keyof typeof reviewed]++
  })
  const reviewedTotal = reviewed.accepted + reviewed.false_positive + reviewed.fixed
  const setChecks = r.set_assessment.checks
  const counts: Partial<Record<ReportTab, string>> = {
    findings: String(r.findings.length),
    questions: r.questions?.length ? String(r.questions.length) : undefined,
    requirements: String(r.requirements.length),
    set: setChecks.length ? `${setChecks.filter((c) => c.verdict === 'pass').length}/${setChecks.length}` : undefined,
    checklist: r.checklist?.length ? `${r.checklist.filter((c) => c.answer === 'yes').length}/${r.checklist.length}` : undefined,
  }
  const ready = r.conclusion.ready_for_development
  const crit = r.summary.by_severity.critical ?? 0
  const pct = (n: number) => `${r.findings.length ? (n / r.findings.length) * 100 : 0}%`

  return (
    <ReportContext.Provider value={ctx}>
      <div className="flex h-full min-h-0 gap-3 p-3">
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          {/* Шапка отчёта */}
          <div className="flex flex-wrap items-center gap-x-5 gap-y-3 rounded-2xl bg-card px-4 py-3 shadow-card">
            <Link
              to={`/documents/${run.document_id}`}
              className="flex size-10 shrink-0 items-center justify-center rounded-xl border text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              aria-label={t('common.back')}
            >
              <ArrowLeft className="size-4" />
            </Link>
            <div className="min-w-0 flex-1">
              <h1 className="flex items-center gap-2 truncate text-lg font-semibold tracking-tight">
                <span className="truncate">{r.passport.document_name}</span>
              </h1>
              <div className="mt-1 flex flex-wrap gap-1.5 text-xs text-muted-foreground">
                <span className="rounded-full bg-secondary px-2.5 py-0.5">{formatDate(r.passport.run_at)}</span>
                <span className="rounded-full bg-secondary px-2.5 py-0.5">{r.passport.model}</span>
                <span className="rounded-full bg-secondary px-2.5 py-0.5">{t('report.reqCount', { count: r.summary.requirements_total })}</span>
                <span className="rounded-full bg-secondary px-2.5 py-0.5">{t('report.findingCount', { count: r.summary.findings_total })}</span>
                <span className="hidden items-center gap-2 rounded-full bg-secondary px-2.5 py-0.5 sm:inline-flex" aria-label={t('stats.bySeverity')}>
                  {SEVERITIES.map((sv) => (
                    <span key={sv} className="inline-flex items-center gap-1 tabular-nums" title={t(`severity.${sv}`)}>
                      <span aria-hidden className={cn('inline-block size-2 rounded-full', SEV_DOT[sv])} />
                      {r.summary.by_severity[sv] ?? 0}
                    </span>
                  ))}
                </span>
              </div>
            </div>
            <div className={cn('flex items-center gap-2.5 rounded-full py-1.5 pr-4 pl-1.5', ready ? 'bg-success/10' : 'bg-sev-critical-bg')}>
              <span className={cn('flex size-7 items-center justify-center rounded-full bg-card shadow-xs', ready ? 'text-success' : 'text-sev-critical')}>
                {ready ? <Check className="size-3.5" /> : <X className="size-3.5" />}
              </span>
              <span className="flex flex-col leading-tight">
                <ReadinessBadge ready={ready} plain />
                {!ready && crit > 0 && <span className="text-xs text-muted-foreground">{t('report.criticalCount', { count: crit })}</span>}
              </span>
            </div>
            <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
              <Button variant="outline" onClick={() => setRelaunch(true)} aria-label={t('report.rerun')}>
                <Play />
                <span className="hidden md:inline">{t('report.rerun')}</span>
              </Button>
              <Button variant={chatOpen ? 'secondary' : 'outline'} onClick={() => setChatOpen((v) => !v)} aria-pressed={chatOpen}>
                <MessageSquareText />
                {t('chat.open')}
              </Button>
              <div className="flex overflow-hidden rounded-[10px] bg-cta shadow-primary">
                <Button className="rounded-none shadow-none" onClick={() => exportReport('pdf')} data-testid="download-pdf">
                  <Download />
                  {t('report.downloadPdf')}
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      className="w-9 rounded-none border-l border-white/15 px-0 shadow-none"
                      aria-label={t('report.otherFormats')}
                      title={t('report.otherFormats')}
                    >
                      <ChevronDown />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {EXPORTS.filter((f) => f !== 'pdf').map((f) => (
                      <DropdownMenuItem key={f} onSelect={() => exportReport(f)}>
                        {t(`report.exportAs.${f}`)}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          </div>

          <Tabs
            value={tab}
            onValueChange={(v) => setTab(v as ReportTab)}
            orientation="vertical"
            className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row"
          >
            {/* Меню разделов */}
            <aside className="flex shrink-0 flex-col gap-3 rounded-2xl bg-card p-2 shadow-card lg:w-60">
              <TabsList className="flex w-full flex-nowrap justify-start gap-0.5 overflow-x-auto rounded-none bg-transparent p-0 [scrollbar-width:none] lg:flex-col lg:items-stretch">
                {TABS.map((v) => {
                  const Icon = TAB_ICONS[v]
                  return (
                    <TabsTrigger
                      key={v}
                      value={v}
                      className="group h-11 shrink-0 justify-start gap-2.5 rounded-xl px-2 font-normal data-[state=active]:bg-[#eef2ff] data-[state=active]:font-medium data-[state=active]:shadow-none dark:data-[state=active]:bg-accent"
                    >
                      <span className="flex size-7 items-center justify-center rounded-lg bg-secondary text-muted-foreground transition-colors group-data-[state=active]:bg-accent-2 group-data-[state=active]:text-white dark:group-data-[state=active]:text-background">
                        <Icon className="size-4" />
                      </span>
                      <span className="flex-1 text-left">{t(`report.tabs.${v}`)}</span>
                      {counts[v] && (
                        <span className="rounded-full bg-secondary px-2 text-xs tabular-nums text-muted-foreground group-data-[state=active]:bg-card">
                          {counts[v]}
                        </span>
                      )}
                    </TabsTrigger>
                  )
                })}
              </TabsList>
              <div className="hidden flex-col gap-2 rounded-xl bg-secondary/70 p-3 lg:flex">
                <span className="flex justify-between text-sm">
                  <span className="text-muted-foreground">{t('report.reviewProgress')}</span>
                  <span className="font-semibold tabular-nums">
                    {reviewedTotal} / {r.findings.length}
                  </span>
                </span>
                <span className="flex h-2 gap-0.5 overflow-hidden rounded-full bg-border">
                  <span className="rounded-full bg-success transition-[width] duration-500" style={{ width: pct(reviewed.accepted) }} />
                  <span className="rounded-full bg-muted-foreground/60 transition-[width] duration-500" style={{ width: pct(reviewed.false_positive) }} />
                  <span className="rounded-full bg-accent-2 transition-[width] duration-500" style={{ width: pct(reviewed.fixed) }} />
                </span>
                <span className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span>
                    <span className="mr-1 inline-block size-2 rounded-full bg-success" />
                    {t('review.accepted')} {reviewed.accepted}
                  </span>
                  <span>
                    <span className="mr-1 inline-block size-2 rounded-full bg-muted-foreground/60" />
                    {t('review.false_positive')} {reviewed.false_positive}
                  </span>
                  <span>
                    <span className="mr-1 inline-block size-2 rounded-full bg-accent-2" />
                    {t('review.fixed')} {reviewed.fixed}
                  </span>
                </span>
              </div>
            </aside>

            <TabsContent value="findings" className="min-h-0 min-w-0 flex-1">
              <div className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)_minmax(0,1fr)] gap-3 md:grid-cols-[minmax(0,1fr)_minmax(320px,420px)] md:grid-rows-1 xl:grid-cols-[minmax(0,1fr)_minmax(380px,470px)]">
                <div className="min-h-0 overflow-hidden rounded-2xl bg-card shadow-card">
                  <DocumentViewer
                    text={r.document.text}
                    findings={visible}
                    activeId={selection.findingId}
                    activeLoc={selection.locIndex}
                    scrollNonce={selection.nonce}
                    shouldScroll={selection.origin !== 'doc'}
                    onSelect={(id, locIndex) => select(id, { locIndex, origin: 'doc' })}
                    focusRange={focusReq}
                  />
                </div>
                <div className="min-h-0 overflow-hidden rounded-2xl bg-card shadow-card">
                  <FindingsPanel visible={visible} filters={filters} setFilters={setFilters} />
                </div>
              </div>
            </TabsContent>
            {TABS.filter((v) => v !== 'findings').map((v) => (
              <TabsContent key={v} value={v} className="min-h-0 min-w-0 flex-1 overflow-y-auto rounded-2xl [&>div]:p-0">
                {v === 'summary' && <SummaryTab run={run} />}
                {v === 'requirements' && <RequirementsTab />}
                {v === 'matrix' && <MatrixTab />}
                {v === 'set' && <SetTab />}
                {v === 'questions' && <QuestionsTab />}
                {v === 'checklist' && <ChecklistTab />}
                {v === 'passport' && <PassportTab run={run} />}
              </TabsContent>
            ))}
          </Tabs>
        </div>

        <aside
          className={cn(
            'min-h-0 shrink-0 overflow-hidden bg-card',
            chatOpen ? 'fixed inset-0 z-30 w-full sm:static sm:w-[380px] sm:rounded-2xl sm:shadow-card xl:w-[420px]' : 'hidden',
          )}
        >
          {chatOpen && <ChatPanel runId={run.id} onClose={() => setChatOpen(false)} />}
        </aside>
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
