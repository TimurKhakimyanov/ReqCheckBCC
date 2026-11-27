import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Download, FileText, MessageSquareText, Play } from 'lucide-react'
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
import { downloadFile, formatDate } from '@/shared/format'
import { cn } from '@/shared/utils'
import { ReportContext, type ReportCtx, type ReportTab, type Selection } from './context'
import { DocumentViewer } from './DocumentViewer'
import { EMPTY_FILTERS, filterFindings, type FindingFilters } from './filters'
import { FindingsPanel } from './FindingsPanel'
import { ChecklistTab, MatrixTab, PassportTab, RequirementsTab, SetTab, SummaryTab } from './tabs'
import { makeOffsetMapper } from './highlight'

const TABS: ReportTab[] = ['findings', 'summary', 'requirements', 'matrix', 'set', 'checklist', 'passport']
const EXPORTS: ExportFormat[] = ['pdf', 'docx', 'md', 'json']

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
      <div className="flex h-full min-h-0">
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Заголовок */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b bg-card/60 px-4 py-3">
            <Link
              to={`/documents/${run.document_id}`}
              className="text-muted-foreground hover:text-foreground"
              aria-label={t('common.back')}
            >
              <ArrowLeft className="size-5" />
            </Link>
            <div className="min-w-0 flex-1">
              <div className="label-mono mb-0.5 hidden sm:block">[ {t('report.eyebrow')} ]</div>
              <h1 className="flex items-center gap-2 truncate text-lg font-medium tracking-tight">
                <FileText className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{r.passport.document_name}</span>
              </h1>
              <p className="truncate text-xs text-muted-foreground">
                {formatDate(r.passport.run_at)} · {t(`provider.${r.passport.provider}`, { defaultValue: r.passport.provider })} ·{' '}
                {r.passport.model} · {t('report.reqCount', { count: r.summary.requirements_total })} ·{' '}
                {t('report.findingCount', { count: r.summary.findings_total })}
              </p>
            </div>
            <ReadinessBadge ready={r.conclusion.ready_for_development} />
            <div className="flex w-full items-center gap-2 sm:w-auto">
              <Button variant="outline" size="sm" onClick={() => setRelaunch(true)} aria-label={t('report.rerun')}>
                <Play />
                <span className="hidden md:inline">{t('report.rerun')}</span>
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" aria-label={t('report.export')}>
                    <Download />
                    <span className="hidden md:inline">{t('report.export')}</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {EXPORTS.map((f) => (
                    <DropdownMenuItem key={f} onSelect={() => exportReport(f)}>
                      {t(`report.exportAs.${f}`)}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                variant={chatOpen ? 'secondary' : 'default'}
                size="sm"
                className="ml-auto sm:ml-0"
                onClick={() => setChatOpen((v) => !v)}
                aria-pressed={chatOpen}
              >
                <MessageSquareText />
                {t('chat.open')}
              </Button>
            </div>
          </div>

          <Tabs value={tab} onValueChange={(v) => setTab(v as ReportTab)} className="flex min-h-0 flex-1 flex-col">
            <div className="overflow-x-auto border-b px-4 py-2 [scrollbar-width:none]">
              <TabsList>
                {TABS.map((v) => (
                  <TabsTrigger key={v} value={v}>
                    {t(`report.tabs.${v}`)}
                    {v === 'findings' && <span className="text-xs text-muted-foreground tabular-nums">{r.findings.length}</span>}
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>

            <TabsContent value="findings" className="min-h-0 flex-1">
              <div className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)_minmax(0,1fr)] md:grid-cols-[minmax(0,1fr)_minmax(320px,420px)] md:grid-rows-1 xl:grid-cols-[minmax(0,1fr)_minmax(380px,480px)]">
                <div className="min-h-0 border-b md:border-r md:border-b-0">
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
                <div className="min-h-0 bg-background">
                  <FindingsPanel visible={visible} filters={filters} setFilters={setFilters} />
                </div>
              </div>
            </TabsContent>
            {TABS.filter((v) => v !== 'findings').map((v) => (
              <TabsContent key={v} value={v} className="min-h-0 flex-1 overflow-y-auto">
                {v === 'summary' && <SummaryTab />}
                {v === 'requirements' && <RequirementsTab />}
                {v === 'matrix' && <MatrixTab />}
                {v === 'set' && <SetTab />}
                {v === 'checklist' && <ChecklistTab />}
                {v === 'passport' && <PassportTab run={run} />}
              </TabsContent>
            ))}
          </Tabs>
        </div>

        <aside
          className={cn(
            'min-h-0 shrink-0 border-l bg-card',
            chatOpen ? 'fixed inset-0 z-30 w-full sm:static sm:w-[380px] xl:w-[420px]' : 'hidden',
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
