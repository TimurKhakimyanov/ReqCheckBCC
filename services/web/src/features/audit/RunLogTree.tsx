import { useQuery } from '@tanstack/react-query'
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Circle,
  CircleSlash,
  Copy,
  Cpu,
  ExternalLink,
  FileText,
  Flag,
  ListTree,
  Loader2,
  Play,
  Search,
  Server,
  Sparkles,
  User,
  XCircle,
} from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { api } from '@/api/client'
import type { AuditEntry, Run, RunLogEntry, RunLogs } from '@/api/types'
import { isTerminal } from '@/api/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input, NativeSelect } from '@/components/ui/input'
import { EmptyState, ErrorNote, Skeleton } from '@/components/ui/misc'
import { RunStatusBadge } from '@/features/runs/RunBits'
import { formatDate, formatNumber, formatUsd } from '@/shared/format'
import { cn } from '@/shared/utils'
import { defaultOpen, groupRunLogs, isLlmCall, matchesFilter, totals, type GroupState, type LogFilter, type LogGroup } from './logTree'

// ---------------------------------------------------------------- форматирование

const pad = (n: number, w = 2) => String(n).padStart(w, '0')
export function clock(iso: string) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

function useDur() {
  const { t } = useTranslation()
  return (ms: number | null | undefined) => {
    if (ms == null || !Number.isFinite(ms)) return '—'
    if (ms < 1000) return t('audit.ms', { value: Math.round(ms) })
    if (ms < 60_000) return t('audit.sec', { value: (ms / 1000).toFixed(1) })
    const s = Math.round(ms / 1000)
    return `${Math.floor(s / 60)}:${pad(s % 60)}`
  }
}

const runDurationMs = (r: Run) => {
  const a = Date.parse(r.started_at ?? r.created_at)
  const b = r.finished_at ? Date.parse(r.finished_at) : Date.now()
  return Number.isNaN(a) || Number.isNaN(b) ? null : Math.max(0, b - a)
}

// ---------------------------------------------------------------- навигатор: документы → прогоны

type StatusFilter = 'all' | 'done' | 'failed' | 'active'

interface DocNode {
  id: string
  name: string
  runs: Run[]
}

function groupByDocument(runs: Run[]): DocNode[] {
  const map = new Map<string, DocNode>()
  for (const r of runs) {
    const d = map.get(r.document_id) ?? { id: r.document_id, name: r.document_name, runs: [] }
    d.runs.push(r)
    map.set(r.document_id, d)
  }
  return [...map.values()]
}

function statusDot(status: Run['status']) {
  if (status === 'done') return 'bg-success'
  if (status === 'failed') return 'bg-destructive'
  if (status === 'cancelled') return 'bg-muted-foreground/50'
  return 'bg-primary animate-[rc-live_1.4s_ease-in-out_infinite]'
}

function RunNavigator({ selected, onSelect, runs }: { selected: string | null; onSelect: (id: string) => void; runs: Run[] }) {
  const { t } = useTranslation()
  const dur = useDur()
  const [q, setQ] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [closed, setClosed] = useState<Set<string>>(new Set())

  const docs = useMemo(() => {
    const s = q.trim().toLowerCase()
    const filtered = runs.filter(
      (r) =>
        (!s || r.document_name.toLowerCase().includes(s) || r.id.startsWith(s)) &&
        (status === 'all' || (status === 'active' ? !isTerminal(r.status) : r.status === status)),
    )
    return groupByDocument(filtered)
  }, [runs, q, status])

  const toggle = (id: string) =>
    setClosed((prev) => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  return (
    <Card className="flex min-h-0 flex-col overflow-hidden lg:sticky lg:top-0 lg:max-h-[calc(100vh-9rem)]">
      <div className="grid gap-2 border-b p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('audit.searchDocs')} className="pl-8" aria-label={t('audit.searchDocs')} />
        </div>
        <NativeSelect value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} aria-label={t('audit.allStatuses')}>
          <option value="all">{t('audit.allStatuses')}</option>
          <option value="active">{t('audit.statusActive')}</option>
          <option value="done">{t('stage.done')}</option>
          <option value="failed">{t('stage.failed')}</option>
        </NativeSelect>
      </div>
      <div role="tree" aria-label={t('audit.tabs.runs')} className="min-h-0 flex-1 overflow-y-auto p-2">
        {!docs.length && <p className="px-2 py-6 text-center text-sm text-muted-foreground">{t('audit.noMatches')}</p>}
        {docs.map((d) => {
          const open = !closed.has(d.id)
          return (
            <div key={d.id} role="treeitem" aria-expanded={open} aria-selected={false} className="mb-1">
              <button
                type="button"
                onClick={() => toggle(d.id)}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-secondary"
              >
                <ChevronRight className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
                <FileText className="size-4 shrink-0 text-primary" />
                <span className="min-w-0 flex-1 truncate font-medium" title={d.name}>
                  {d.name}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{d.runs.length}</span>
              </button>
              {open && (
                <div role="group" className="relative ml-[1.05rem] border-l pl-2">
                  {d.runs.map((r) => {
                    const active = r.id === selected
                    return (
                      <button
                        key={r.id}
                        type="button"
                        role="treeitem"
                        aria-selected={active}
                        onClick={() => onSelect(r.id)}
                        data-testid={`nav-run-${r.id}`}
                        className={cn(
                          'relative mt-0.5 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors',
                          'before:absolute before:top-1/2 before:-left-2 before:h-px before:w-2 before:bg-border',
                          active ? 'bg-primary-tint text-foreground' : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
                        )}
                      >
                        <span className={cn('size-2 shrink-0 rounded-full', statusDot(r.status))} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-foreground/90">{formatDate(r.created_at)}</span>
                          <span className="block truncate">
                            {r.provider} · {r.model}
                          </span>
                        </span>
                        <span className="shrink-0 tabular-nums">{dur(runDurationMs(r))}</span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------- шапка прогона и шкала агентов

const STATE_BAR: Record<GroupState, string> = {
  done: 'bg-success/70',
  active: 'bg-primary animate-[rc-live_1.4s_ease-in-out_infinite]',
  failed: 'bg-destructive',
  pending: 'bg-muted',
  skipped: 'bg-muted',
}

function Timeline({ groups, start }: { groups: LogGroup[]; start: number }) {
  const { t } = useTranslation()
  const dur = useDur()
  const spans = groups.filter((g) => g.startedAt != null && g.endedAt != null)
  const end = Math.max(...spans.map((g) => g.endedAt as number), start + 1)
  const total = end - start
  if (!spans.length) return null
  return (
    <div className="grid gap-1.5" aria-label={t('audit.timeline')}>
      <div className="relative h-2.5 overflow-hidden rounded-full bg-muted">
        {spans.map((g) => {
          const left = (((g.startedAt as number) - start) / total) * 100
          const width = Math.max(0.6, (((g.endedAt as number) - (g.startedAt as number)) / total) * 100)
          return (
            <span
              key={g.key}
              title={`${groupTitle(g, t)} · ${dur((g.endedAt as number) - (g.startedAt as number))}`}
              className={cn('absolute inset-y-0 origin-left rounded-full border-r-2 border-card', STATE_BAR[g.state])}
              style={{ left: `${left}%`, width: `${width}%`, animation: 'rc-grow 0.8s cubic-bezier(0.22,0.61,0.36,1) both' }}
            />
          )
        })}
      </div>
      <div className="flex justify-between text-[11px] text-muted-foreground tabular-nums">
        <span>0</span>
        <span>{dur(total)}</span>
      </div>
    </div>
  )
}

function Stat({ icon, label, value }: { icon: ReactNode; label: string; value: ReactNode }) {
  return (
    <div className="flex min-w-0 items-start gap-2.5 rounded-xl bg-secondary/60 px-3 py-2">
      <span className="mt-0.5 text-muted-foreground [&_svg]:size-4">{icon}</span>
      <span className="min-w-0">
        <span className="label-mono block">{label}</span>
        <span className="block text-sm font-medium break-words tabular-nums">{value}</span>
      </span>
    </div>
  )
}

function RunHeader({ logs, groups }: { logs: RunLogs; groups: LogGroup[] }) {
  const { t } = useTranslation()
  const dur = useDur()
  const r = logs.run
  const sum = totals(groups)
  const copy = () => {
    void navigator.clipboard?.writeText(r.id).then(() => toast.success(t('audit.copied')))
  }
  return (
    <Card className="rc-fade grid gap-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <FileText className="size-4 shrink-0" />
            <span className="truncate">{r.document_name}</span>
          </div>
          <h2 className="mt-1 flex flex-wrap items-center gap-2 text-lg font-semibold tracking-tight">
            {r.provider} · {r.model}
            <RunStatusBadge status={r.status} />
            {!isTerminal(r.status) && (
              <Badge variant="outline" className="gap-1.5">
                <span className="size-1.5 animate-[rc-live_1.4s_ease-in-out_infinite] rounded-full bg-primary" />
                {t('audit.live')}
              </Badge>
            )}
          </h2>
          <button type="button" onClick={copy} className="mt-1 inline-flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground" title={t('audit.copyId')}>
            {r.id}
            <Copy className="size-3" />
          </button>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link to={`/runs/${r.id}`}>
            <ExternalLink />
            {t('audit.openRun')}
          </Link>
        </Button>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 2xl:grid-cols-4">
        <Stat icon={<Play />} label={t('audit.started')} value={formatDate(r.started_at ?? r.created_at, { timeStyle: 'medium' })} />
        <Stat icon={<Activity />} label={t('audit.duration')} value={dur(runDurationMs(r))} />
        <Stat
          icon={<Sparkles />}
          label={t('audit.llmCalls')}
          value={`${formatNumber(r.usage?.llm_calls ?? sum.llmCalls)} · ${formatNumber(r.usage?.prompt_tokens)}→${formatNumber(r.usage?.completion_tokens)}`}
        />
        <Stat
          icon={<AlertTriangle />}
          label={t('audit.problems')}
          value={
            <span className="flex flex-wrap gap-x-2">
              <span className={cn(sum.warnings && 'text-warning')}>{t('audit.warningsCount', { count: sum.warnings })}</span>
              <span className={cn(sum.errors && 'text-destructive')}>{t('audit.errorsCount', { count: sum.errors })}</span>
            </span>
          }
        />
      </div>
      {r.usage?.cost_usd ? <p className="-mt-2 text-xs text-muted-foreground">{t('audit.cost')}: {formatUsd(r.usage.cost_usd)}</p> : null}
      <Timeline groups={groups} start={Date.parse(r.started_at ?? r.created_at)} />
      {r.error && <ErrorNote error={new Error(r.error)} />}
    </Card>
  )
}

// ---------------------------------------------------------------- дерево агентов

function groupTitle(g: LogGroup, t: (k: string) => string) {
  if (g.kind === 'start') return t('audit.groups.start')
  if (g.kind === 'finish') return t('audit.groups.finish')
  return t(`stage.${g.stage}`)
}

function StateIcon({ state }: { state: GroupState }) {
  const cls = 'size-4 shrink-0'
  if (state === 'done') return <CheckCircle2 className={cn(cls, 'text-success')} />
  if (state === 'failed') return <XCircle className={cn(cls, 'text-destructive')} />
  if (state === 'active') return <Loader2 className={cn(cls, 'animate-spin text-primary')} />
  if (state === 'skipped') return <CircleSlash className={cn(cls, 'text-muted-foreground')} />
  return <Circle className={cn(cls, 'text-muted-foreground/60')} />
}

const LEVEL_DOT: Record<string, string> = {
  debug: 'bg-muted-foreground/40',
  info: 'bg-muted-foreground/45',
  warning: 'bg-warning',
  error: 'bg-destructive',
  critical: 'bg-destructive',
}

const SOURCE_ICON: Record<string, ReactNode> = {
  progress: <Activity />,
  core: <Cpu />,
  llm: <Sparkles />,
  worker: <Server />,
  system: <Server />,
}

function LogLine({ e, start }: { e: RunLogEntry; start: number }) {
  const { t } = useTranslation()
  const dur = useDur()
  const [open, setOpen] = useState(false)
  const data = Object.fromEntries(Object.entries(e.data ?? {}).filter(([k]) => k !== 'logger'))
  const hasData = Object.keys(data).length > 0
  const offset = Date.parse(e.ts) - start
  const llm = isLlmCall(e)
  const problem = e.level === 'warning' ? 'bg-warning/10' : e.level === 'error' || e.level === 'critical' ? 'bg-destructive/10' : ''
  return (
    <li
      className={cn(
        'relative before:absolute before:top-3.5 before:-left-3 before:h-px before:w-3 before:bg-border',
        'rounded-lg',
        problem,
      )}
      data-testid="log-line"
      data-level={e.level}
    >
      <button
        type="button"
        onClick={() => hasData && setOpen((v) => !v)}
        aria-expanded={hasData ? open : undefined}
        className={cn('flex w-full items-start gap-2 rounded-lg px-2 py-1 text-left text-[13px]', hasData && 'cursor-pointer hover:bg-secondary/70')}
      >
        <span className="mt-1.5 shrink-0">
          <span className={cn('block size-2 rounded-full', LEVEL_DOT[e.level] ?? LEVEL_DOT.info)} title={e.level} />
        </span>
        <span className="hidden w-[6.6rem] shrink-0 font-mono text-[11px] leading-5 text-muted-foreground sm:block" title={e.ts}>
          {clock(e.ts)}
        </span>
        <span className="hidden w-14 shrink-0 text-right font-mono text-[11px] leading-5 text-muted-foreground/80 md:block">
          {Number.isFinite(offset) && offset >= 0 ? `+${(offset / 1000).toFixed(1)}` : ''}
        </span>
        <span
          className="inline-flex h-5 shrink-0 items-center gap-1 rounded-md bg-secondary px-1.5 text-[11px] text-muted-foreground [&_svg]:size-3"
          title={String(e.data?.logger ?? e.source)}
        >
          {SOURCE_ICON[e.source] ?? <Server />}
          {t(`audit.source.${e.source}`, { defaultValue: e.source })}
        </span>
        <span className="min-w-0 flex-1 leading-5 break-words" title={llm ? e.message : undefined}>
          {llm && e.data.schema ? String(e.data.schema) : e.message}
          {e.total ? (
            <span className="ml-2 rounded bg-secondary px-1 font-mono text-[11px] text-muted-foreground">
              {e.current ?? 0}/{e.total}
            </span>
          ) : null}
          {llm && (
            <span className="ml-2 inline-flex flex-wrap gap-1 align-middle">
              <Badge variant="outline" className="px-1.5 py-0 font-mono text-[10px]">
                {dur(Number(e.data.latency_ms))}
              </Badge>
              {e.data.prompt_tokens != null && (
                <Badge variant="outline" className="px-1.5 py-0 font-mono text-[10px]" title={t('audit.tokensHint')}>
                  {formatNumber(Number(e.data.prompt_tokens))}→{formatNumber(Number(e.data.completion_tokens))}
                </Badge>
              )}
            </span>
          )}
        </span>
        {hasData && <ChevronRight className={cn('mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />}
      </button>
      {open && (
        <div className="rc-fade mx-2 mb-2 ml-6">
          <div className="flex items-center justify-between">
            <span className="label-mono">{t('audit.data')}</span>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t('common.copy')}
              onClick={() => void navigator.clipboard?.writeText(JSON.stringify(e.data, null, 2)).then(() => toast.success(t('audit.copied')))}
            >
              <Copy />
            </Button>
          </div>
          {typeof data.exc === 'string' && (
            <pre className="mb-2 max-h-64 overflow-auto rounded-lg bg-destructive/10 p-2 font-mono text-[11px] whitespace-pre-wrap text-destructive">{data.exc}</pre>
          )}
          <pre className="max-h-72 overflow-auto rounded-lg bg-secondary/70 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
            {JSON.stringify(Object.fromEntries(Object.entries(data).filter(([k]) => k !== 'exc')), null, 2)}
          </pre>
        </div>
      )}
    </li>
  )
}

function GroupNode({
  g,
  open,
  onToggle,
  entries,
  start,
}: {
  g: LogGroup
  open: boolean
  onToggle: () => void
  entries: RunLogEntry[]
  start: number
}) {
  const { t } = useTranslation()
  const dur = useDur()
  const span = g.startedAt != null && g.endedAt != null ? g.endedAt - g.startedAt : null
  const icon = g.kind === 'start' ? <Play /> : g.kind === 'finish' ? <Flag /> : null
  return (
    <li role="treeitem" aria-expanded={open} aria-selected={false} className="relative" data-testid={`group-${g.key}`} data-state={g.state}>
      <button
        type="button"
        onClick={onToggle}
        disabled={!g.entries.length}
        className={cn(
          'group flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors',
          g.entries.length ? 'hover:bg-secondary' : 'cursor-default opacity-60',
          open && 'bg-secondary/60',
        )}
      >
        <ChevronRight className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90', !g.entries.length && 'invisible')} />
        <StateIcon state={g.state} />
        {g.meta ? (
          <span className="w-12 shrink-0 font-mono text-[11px] text-muted-foreground">{g.meta.code}</span>
        ) : (
          <span className="flex w-12 shrink-0 text-muted-foreground [&_svg]:size-3.5">{icon}</span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{groupTitle(g, t)}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {g.entries.length ? t('audit.entriesCount', { count: g.entries.length }) : t(`audit.state.${g.state}`)}
            {g.llmCalls > 0 &&
              ` · ${t('audit.llmSummary', { count: g.llmCalls, time: dur(g.llmMs) })}${g.tokensIn ? ` · ${formatNumber(g.tokensIn)}→${formatNumber(g.tokensOut)}` : ''}`}
          </span>
        </span>
        {g.warnings > 0 && (
          <Badge variant="warning" className="shrink-0">
            <AlertTriangle />
            {g.warnings}
          </Badge>
        )}
        {g.errors > 0 && (
          <Badge variant="destructive" className="shrink-0">
            <XCircle />
            {g.errors}
          </Badge>
        )}
        <span className="w-16 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{span != null ? dur(span) : ''}</span>
      </button>
      {open && (
        <ul role="group" className="relative mt-0.5 mb-2 ml-[1.15rem] grid gap-px border-l pl-3">
          {entries.length ? (
            entries.map((e) => <LogLine key={e.id} e={e} start={start} />)
          ) : (
            <li className="px-2 py-1 text-xs text-muted-foreground">{t('audit.noMatches')}</li>
          )}
        </ul>
      )}
    </li>
  )
}

function ActionsNode({ items, open, onToggle }: { items: AuditEntry[]; open: boolean; onToggle: () => void }) {
  const { t } = useTranslation()
  if (!items.length) return null
  return (
    <li role="treeitem" aria-expanded={open} aria-selected={false}>
      <button type="button" onClick={onToggle} className={cn('flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left hover:bg-secondary', open && 'bg-secondary/60')}>
        <ChevronRight className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
        <User className="size-4 shrink-0 text-primary" />
        <span className="w-12 shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{t('audit.groups.actions')}</span>
          <span className="block text-xs text-muted-foreground">{t('audit.entriesCount', { count: items.length })}</span>
        </span>
      </button>
      {open && (
        <ul role="group" className="mt-0.5 mb-2 ml-[1.15rem] grid gap-px border-l pl-3">
          {items.map((a) => (
            <li key={a.id} className="relative flex items-center gap-2 rounded-lg px-2 py-1 text-[13px] before:absolute before:top-1/2 before:-left-3 before:h-px before:w-3 before:bg-border">
              <span className="hidden w-[6.6rem] shrink-0 font-mono text-[11px] text-muted-foreground sm:block">{clock(a.ts)}</span>
              <span className="font-medium">{a.actor}</span>
              <Badge variant="outline" className="font-mono">
                {a.action}
              </Badge>
              <span className="truncate font-mono text-xs text-muted-foreground">{a.target}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

function RunDetail({ runId }: { runId: string }) {
  const { t } = useTranslation()
  const q = useQuery({
    queryKey: ['run-logs', runId],
    queryFn: () => api.runLogs(runId),
    refetchInterval: (query) => (query.state.data && !isTerminal(query.state.data.run.status) ? 2500 : false),
  })
  const [filter, setFilter] = useState<LogFilter>('all')
  const [search, setSearch] = useState('')
  const groups = useMemo(() => (q.data ? groupRunLogs(q.data) : []), [q.data])
  const [open, setOpen] = useState<Set<string> | null>(null) // null — раскрытие по умолчанию (defaultOpen)
  const opened = open ?? defaultOpen(groups)
  const narrowing = filter !== 'all' || search.trim() !== ''
  const filtered = useMemo(
    () => new Map(groups.map((g) => [g.key, g.entries.filter((e) => matchesFilter(e, filter, search))])),
    [groups, filter, search],
  )
  const [actionsOpen, setActionsOpen] = useState(false)

  if (q.isPending) return <Skeleton className="h-96 rounded-2xl" />
  if (q.error) return <ErrorNote error={q.error} />
  const logs = q.data
  const start = Date.parse(logs.run.started_at ?? logs.run.created_at)
  const toggle = (k: string) => {
    const n = new Set(opened)
    if (n.has(k)) n.delete(k)
    else n.add(k)
    setOpen(n)
  }
  const visible = groups.filter((g) => !narrowing || (filtered.get(g.key)?.length ?? 0) > 0)

  return (
    <div className="grid min-w-0 gap-4">
      <RunHeader logs={logs} groups={groups} />
      <Card className="rc-fade min-w-0 p-3 sm:p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-full bg-secondary p-1" role="radiogroup" aria-label={t('audit.filterLabel')}>
            {(['all', 'llm', 'problems'] as LogFilter[]).map((f) => (
              <button
                key={f}
                type="button"
                role="radio"
                aria-checked={filter === f}
                onClick={() => setFilter(f)}
                className={cn(
                  'h-7 rounded-full px-3 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground',
                  filter === f && 'bg-card text-foreground shadow-xs',
                )}
              >
                {t(`audit.filter.${f}`)}
              </button>
            ))}
          </div>
          <div className="relative min-w-40 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('audit.searchLogs')} className="h-8 pl-8" aria-label={t('audit.searchLogs')} />
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(new Set(groups.filter((g) => g.entries.length).map((g) => g.key)))}>
            <ChevronsUpDown />
            {t('audit.expandAll')}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(new Set())}>
            <ChevronsDownUp />
            {t('audit.collapseAll')}
          </Button>
        </div>
        {logs.truncated && <p className="mb-2 rounded-lg bg-warning/15 px-3 py-2 text-xs">{t('audit.truncated')}</p>}
        {!logs.items.length ? (
          <EmptyState icon={<ListTree />} title={t('audit.noLogs')} hint={t('audit.noLogsHint')} />
        ) : !visible.length ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{t('audit.noMatches')}</p>
        ) : (
          <ul role="tree" aria-label={t('audit.agentsTree')} className="grid gap-0.5">
            {visible.map((g) => (
              <GroupNode
                key={g.key}
                g={g}
                open={narrowing ? true : opened.has(g.key)}
                onToggle={() => toggle(g.key)}
                entries={filtered.get(g.key) ?? []}
                start={start}
              />
            ))}
            {!narrowing && <ActionsNode items={logs.audit} open={actionsOpen} onToggle={() => setActionsOpen((v) => !v)} />}
          </ul>
        )}
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------- вкладка целиком

export function RunLogsTab({ runId, onSelect }: { runId: string | null; onSelect: (id: string) => void }) {
  const { t } = useTranslation()
  const runs = useQuery({
    queryKey: ['runs', 'audit'],
    queryFn: () => api.runs({ limit: 200 }),
    refetchInterval: (query) => (query.state.data?.items.some((r) => !isTerminal(r.status)) ? 4000 : false),
  })
  const items = runs.data?.items ?? []
  const selected = runId && items.some((r) => r.id === runId) ? runId : (items[0]?.id ?? null)

  if (runs.isPending)
    return (
      <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        <Skeleton className="h-96 rounded-2xl" />
        <Skeleton className="h-96 rounded-2xl" />
      </div>
    )
  if (runs.error) return <ErrorNote error={runs.error} />
  if (!items.length)
    return (
      <Card>
        <EmptyState icon={<ListTree />} title={t('audit.noRuns')} hint={t('audit.noRunsHint')}>
          <Button asChild size="sm" className="mt-2">
            <Link to="/documents">{t('nav.documents')}</Link>
          </Button>
        </EmptyState>
      </Card>
    )
  return (
    <div className="grid items-start gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
      <RunNavigator runs={items} selected={selected} onSelect={onSelect} />
      {selected ? <RunDetail key={selected} runId={selected} /> : <EmptyState title={t('audit.pickRun')} />}
    </div>
  )
}
