import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ChevronLeft, ChevronRight, CircleX, Crosshair, Play } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { api } from '@/api/client'
import type { ProgressEvent, Run, RunStage } from '@/api/types'
import { isTerminal } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/misc'
import { ProviderErrorNote } from '@/features/errors/ProviderErrorNote'
import { formatNumber } from '@/shared/format'
import { cn } from '@/shared/utils'
import { AgentCube, ConveyorScene, StackScene } from './AgentScene'
import { AGENTS, agentRuntimes, formatClock, throughputPerMin, type AgentRuntime, type AgentState } from './agents'
import { LaunchRunDialog } from './LaunchRunDialog'
import { AskAuthorPanel } from './AskAuthorPanel'
import { useRunEvents } from './useRunEvents'

const STATE_COLOR: Record<AgentState, string> = {
  pending: 'text-muted-foreground',
  active: 'text-primary',
  done: 'text-teal',
  failed: 'text-destructive',
}
const STATE_BG: Record<AgentState, string> = {
  pending: 'bg-muted-foreground',
  active: 'bg-primary',
  done: 'bg-teal',
  failed: 'bg-destructive',
}

/** Текущее время, тикает раз в секунду, пока прогон идёт. */
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [active])
  return now
}

const timeOf = (iso?: string | null) => {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function Label({ children, className, dot }: { children: ReactNode; className?: string; dot?: string }) {
  return (
    <div className={cn('label-mono flex items-center gap-2', className)}>
      {dot && <span aria-hidden className={cn('inline-block size-1.5 rounded-full', dot)} />}
      {children}
    </div>
  )
}

export function RunProgress({ run }: { run: Run }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [relaunch, setRelaunch] = useState(false)
  const [view, setView] = useState<'conveyor' | 'stack'>('conveyor')
  const [sel, setSel] = useState<number | null>(null)
  const terminal = isTerminal(run.status)
  const { events, latest, state } = useRunEvents(run.id, !terminal, () => {
    void qc.invalidateQueries({ queryKey: ['run', run.id] })
    void qc.invalidateQueries({ queryKey: ['documents'] })
    void qc.invalidateQueries({ queryKey: ['runs'] })
  })
  const cancel = useMutation({
    mutationFn: () => api.cancelRun(run.id),
    onSuccess: (r) => qc.setQueryData(['run', run.id], r),
  })

  const stage: RunStage = latest?.stage ?? run.stage ?? run.status
  const progress = latest?.progress ?? run.progress ?? 0
  const message = latest?.message || run.message
  const failed = stage === 'failed' || stage === 'cancelled'
  const finished = stage === 'done'
  const running = !failed && !finished && !terminal
  const now = useNow(running)

  const agentIdx = AGENTS.findIndex((a) => a.stage === stage)
  // для упавшего прогона — последний достигнутый агент
  // (открыт из истории — событий нет, стадия сбоя неизвестна: не отмечаем ни одного)
  const seen = events.map((e) => AGENTS.findIndex((a) => a.stage === e.stage)).filter((i) => i >= 0)
  const reachedIdx = failed ? (seen.length ? Math.max(...seen) : -1) : agentIdx
  const rts = agentRuntimes(events, reachedIdx, finished, failed)
  const states = rts.map((r) => r.state)
  const si = sel ?? (reachedIdx >= 0 ? reachedIdx : 0)
  const thr = throughputPerMin(events)

  const startedMs = Date.parse(run.started_at ?? run.created_at)
  const endMs = run.finished_at ? Date.parse(run.finished_at) : now
  const elapsed = Number.isNaN(startedMs) ? null : endMs - startedMs

  const log = dedupe(events)
  const timeline = log.slice(-5)

  const cur = reachedIdx >= 0 ? rts[reachedIdx] : null
  const curAgent = reachedIdx >= 0 ? AGENTS[reachedIdx] : null
  const cardState: AgentState = failed ? 'failed' : finished ? 'done' : cur ? 'active' : 'pending'
  const cardFrac = cur?.total ? (cur.current ?? 0) / cur.total : progress

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[1440px] flex-col gap-3 p-3">
        {/* Шапка прогона */}
        <header className="flex flex-wrap items-center justify-between gap-x-5 gap-y-3 rounded-2xl bg-card shadow-card px-4 py-3">
          <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
            <Link
              to={`/documents/${run.document_id}`}
              className="inline-flex min-w-0 items-center gap-1.5 font-mono text-xs text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="size-3.5 shrink-0" />
              <span className="truncate">{run.document_name}</span>
            </Link>
            <h1 className="text-lg font-medium tracking-tight">{failed ? t('progress.titleFailed') : t('progress.title')}</h1>
            <span className={cn('inline-flex items-center gap-2 font-mono text-xs', STATE_COLOR[cardState])}>
              <span aria-hidden className={cn('inline-block size-1.5 rounded-full', STATE_BG[cardState], running && 'rc-live')} />
              {t(`stage.${stage}`)}
            </span>
          </div>

          <div role="tablist" aria-label={t('runView.view')} className="flex gap-1 border bg-background p-0.5">
            {(['conveyor', 'stack'] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={view === v}
                onClick={() => setView(v)}
                className={cn(
                  'min-h-8 cursor-pointer px-3 text-sm transition-colors',
                  view === v ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {t(`runView.${v}`)}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className="font-mono text-xs text-muted-foreground">
              {t(`provider.${run.provider}`, { defaultValue: run.provider })} · {run.model}
            </span>
            {elapsed != null && (
              <span className="font-mono text-xs tabular-nums" title={t('runView.elapsed')}>
                {formatClock(elapsed)}
              </span>
            )}
            <span className={cn('text-2xl font-medium tracking-tight tabular-nums', STATE_COLOR[cardState])}>
              {Math.round(progress * 100)}%
            </span>
            {running && (
              <span className="font-mono text-xs text-muted-foreground" title={t(`progress.stream.${state}`)}>
                <span className={cn('mr-1.5 inline-block size-1.5 rounded-full', state === 'open' ? 'bg-teal' : 'bg-muted-foreground')} />
                {t(`progress.stream.${state}`)}
              </span>
            )}
            {running ? (
              <Button variant="outline" size="sm" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
                {cancel.isPending ? <Spinner /> : <CircleX />}
                {t('progress.cancel')}
              </Button>
            ) : (
              <Button size="sm" onClick={() => setRelaunch(true)}>
                <Play />
                {t('progress.retry')}
              </Button>
            )}
          </div>
        </header>

        {failed && (run.error || message) && <ProviderErrorNote raw={run.error || message || ''} />}

        <AskAuthorPanel run={run} active={running} />

        <div className="flex flex-wrap items-stretch gap-3">
          {/* Этапы-агенты */}
          <aside className="flex max-w-full flex-[1_1_280px] flex-col rounded-2xl bg-card shadow-card">
            <Label className="border-b px-4 py-3" dot="bg-primary">
              {t('progress.stages')}
            </Label>
            <ol aria-label={t('progress.stages')} className="flex flex-col">
              {AGENTS.map((a, i) => {
                const rt = rts[i]
                const dur = rt.startedAt && (rt.finishedAt ?? (rt.state === 'active' ? now : null))
                return (
                  <li key={a.stage} data-state={rt.state} className="border-b last:border-b-0">
                    <button
                      type="button"
                      onClick={() => setSel(i)}
                      aria-pressed={si === i}
                      className={cn(
                        'rc-smooth flex w-full cursor-pointer flex-col gap-1.5 px-4 py-3 text-left hover:bg-accent',
                        rt.state === 'active' && 'bg-primary-tint shadow-[inset_-2px_0_0_var(--primary)]',
                        si === i && rt.state !== 'active' && 'bg-accent',
                      )}
                    >
                      <span className="flex w-full items-center justify-between gap-2 font-mono text-xs">
                        <span className="tracking-wider uppercase">
                          <span className="text-muted-foreground">{a.code}</span>{' '}
                          <span className={rt.state === 'pending' ? 'text-muted-foreground' : rt.state === 'done' ? 'text-foreground' : STATE_COLOR[rt.state]}>
                            {t(`stage.${a.stage}`)}
                          </span>
                        </span>
                        <span className={cn('shrink-0', STATE_COLOR[rt.state])}>
                          {rt.state === 'active' && rt.total
                            ? `${rt.current ?? 0} / ${rt.total}`
                            : rt.state === 'done' && dur && rt.startedAt
                              ? formatClock(dur - rt.startedAt)
                              : t(`runView.status.${rt.state}`)}
                        </span>
                      </span>
                      <span className="text-xs leading-relaxed text-muted-foreground">{t(`stageHint.${a.stage}`)}</span>
                      {rt.state === 'active' && rt.total ? (
                        <span className="block h-0.5 bg-border">
                          <span className="rc-smooth block h-0.5 bg-primary" style={{ width: `${((rt.current ?? 0) / rt.total) * 100}%` }} />
                        </span>
                      ) : null}
                    </button>
                  </li>
                )
              })}
            </ol>
            {thr != null && (
              <div className="mt-auto flex items-baseline justify-between gap-2 border-t px-4 py-3">
                <span className="label-mono">{t('runView.throughput')}</span>
                <span className="text-xl font-medium tabular-nums">
                  {formatNumber(thr, 1)} <span className="font-mono text-xs text-muted-foreground">{t('runView.perMin')}</span>
                </span>
              </div>
            )}
          </aside>

          {/* Сцена */}
          <main className="flex min-w-0 flex-[3_1_560px] flex-col gap-3">
            <div className="relative min-h-[560px] flex-1 overflow-hidden border bg-[radial-gradient(120%_80%_at_50%_40%,var(--card)_0%,var(--background)_70%)]">
              <div className="absolute top-3 left-1/2 z-10 w-[min(520px,calc(100%-24px))] -translate-x-1/2 border bg-popover/95 px-4 py-3 backdrop-blur">
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className="flex min-w-0 items-center gap-2.5">
                    <span aria-hidden className={cn('inline-block size-1.5 rounded-full shrink-0', STATE_BG[cardState], running && 'rc-live')} />
                    <span className={cn('shrink-0 font-mono', STATE_COLOR[cardState])}>
                      {finished ? 'DONE' : failed ? 'FAIL' : (curAgent?.code ?? 'QUEUE')}
                    </span>
                    <span className="truncate">{t(`stage.${stage}`)}</span>
                    {running && <span className="rc-caret text-primary">▍</span>}
                  </span>
                  <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                    {cur?.startedAt ? formatClock((cur.finishedAt ?? (running ? now : (cur.events.at(-1) ? Date.parse(cur.events.at(-1)!.ts) : now))) - cur.startedAt) : '—'}
                  </span>
                </div>
                <p className="mt-1.5 truncate text-xs text-muted-foreground" aria-live="polite">
                  {message || (stage === 'queued' ? t('stageHint.queued') : curAgent ? t(`stageHint.${curAgent.stage}`) : '')}
                </p>
                <div className="mt-2.5 flex items-center gap-3">
                  <span className="block h-0.5 flex-1 bg-border">
                    <span
                      className={cn('rc-smooth block h-0.5', STATE_BG[cardState])}
                      style={{ width: `${Math.round(Math.min(1, Math.max(0, cardFrac)) * 100)}%` }}
                    />
                  </span>
                  {cur?.total ? (
                    <span className="font-mono text-xs tabular-nums">
                      {cur.current ?? 0} / {cur.total}
                    </span>
                  ) : null}
                </div>
              </div>

              {view === 'conveyor' ? <ConveyorScene states={states} finished={finished} /> : <StackScene states={states} finished={finished} />}

              <div className="absolute inset-x-3 bottom-2.5 z-10 flex flex-wrap justify-between gap-2 font-mono text-[0.6875rem] text-muted-foreground">
                <span className="flex flex-wrap gap-4">
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block h-0.5 w-3.5 bg-[var(--scene-done)]" />
                    {t('runView.legendDone')}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block h-0.5 w-3.5 bg-primary" />
                    {t('runView.legendActive')}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block size-2 rounded-full rotate-45 border border-muted-foreground" />
                    {t('runView.legendPacket')}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block size-2 rounded-full bg-teal" />
                    {t('runView.legendReady')}
                  </span>
                </span>
              </div>
            </div>

            {/* Хронология событий */}
            <section className="rounded-2xl bg-card shadow-card px-4 py-3">
              <div className="mb-3 flex justify-between">
                <Label dot="bg-foreground">{t('runView.timeline')}</Label>
                {running && (
                  <span className="label-mono">
                    <span className="rc-live text-teal">●</span> live
                  </span>
                )}
              </div>
              {timeline.length ? (
                <ol className="relative grid grid-cols-[repeat(auto-fit,minmax(120px,1fr))] gap-2">
                  <span aria-hidden className="absolute inset-x-0 top-[27px] h-px bg-border" />
                  {timeline.map((e, i) => {
                    const last = i === timeline.length - 1
                    const color = isTerminal(e.stage)
                      ? e.stage === 'done'
                        ? 'bg-teal'
                        : 'bg-destructive'
                      : last
                        ? 'bg-primary'
                        : 'bg-teal'
                    return (
                      <li key={`${e.ts}|${e.stage}|${e.message}|${e.current ?? ''}`} className="rc-fade relative flex min-w-0 flex-col items-center gap-1.5 text-center">
                        <span className={cn('max-w-full truncate text-xs', last ? 'text-foreground' : 'text-muted-foreground')} title={e.message}>
                          {e.message || t(`stage.${e.stage}`)}
                        </span>
                        <span className={cn('block size-1.5 ring-4 ring-[var(--panel)]', color)} />
                        <span className="font-mono text-[0.625rem] text-muted-foreground">{timeOf(e.ts)}</span>
                      </li>
                    )
                  })}
                </ol>
              ) : (
                <p className="text-xs text-muted-foreground">{t('runView.noEvents')}</p>
              )}
              {log.length > 0 && (
                <details className="mt-3 text-xs">
                  <summary className="cursor-pointer text-muted-foreground">{t('progress.log', { count: log.length })}</summary>
                  <ul className="mt-2 max-h-48 overflow-y-auto border bg-background p-2 font-mono">
                    {log.map((e, i) => (
                      <li key={i}>
                        <span className="text-muted-foreground">{timeOf(e.ts)}</span> {e.stage}
                        {e.message ? ` — ${e.message}` : ''}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </section>
          </main>

          <AgentPanel
            idx={si}
            rt={rts[si]}
            model={run.model}
            now={now}
            following={sel === null}
            onSelect={setSel}
            onFollow={() => setSel(null)}
          />
        </div>
      </div>
      <LaunchRunDialog
        document={{ id: run.document_id, name: run.document_name, format: 'md', size_bytes: 0, sha256: '', created_at: run.created_at, runs_count: 0 }}
        open={relaunch}
        onOpenChange={setRelaunch}
      />
    </div>
  )
}

function AgentPanel({
  idx,
  rt,
  model,
  now,
  following,
  onSelect,
  onFollow,
}: {
  idx: number
  rt: AgentRuntime
  model: string
  now: number
  following: boolean
  onSelect: (i: number) => void
  onFollow: () => void
}) {
  const { t } = useTranslation()
  const a = AGENTS[idx]
  const end = rt.finishedAt ?? (rt.state === 'active' ? now : rt.events.at(-1) ? Date.parse(rt.events.at(-1)!.ts) : null)
  const dur = rt.startedAt && end ? formatClock(end - rt.startedAt) : '—'
  const frac = rt.state === 'done' ? 1 : rt.total ? (rt.current ?? 0) / rt.total : 0
  const recent = [...rt.events].reverse().slice(0, 6)
  const stats: [string, string][] = [
    [t('runView.started'), rt.startedAt ? new Date(rt.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—'],
    [t('runView.duration'), dur],
    [t('runView.progressLabel'), rt.total ? `${rt.current ?? 0} / ${rt.total}` : rt.state === 'done' ? '100%' : '—'],
    [t('runView.events'), String(rt.events.length)],
  ]
  return (
    <aside aria-label={t('runView.agent')} className="flex max-w-full flex-[1_1_320px] flex-col rounded-2xl bg-card shadow-card">
      <div className="flex flex-col gap-2.5 border-b px-4 py-3">
        <div className="flex items-center justify-between">
          <span className="label-mono">{t('runView.agent')}</span>
          <span className="flex gap-1">
            <Button variant="outline" size="icon-sm" onClick={() => onSelect(Math.max(0, idx - 1))} aria-label={t('runView.prev')}>
              <ChevronLeft />
            </Button>
            <Button variant="outline" size="icon-sm" onClick={() => onSelect(Math.min(AGENTS.length - 1, idx + 1))} aria-label={t('runView.next')}>
              <ChevronRight />
            </Button>
            <Button variant={following ? 'secondary' : 'outline'} size="sm" className="h-7" onClick={onFollow} aria-pressed={following}>
              <Crosshair />
              {t('runView.follow')}
            </Button>
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="font-mono text-2xl">{a.code}</span>
          <span className="font-mono text-2xl text-muted-foreground">{a.short}</span>
          <span className={cn('rc-smooth inline-flex items-center gap-1.5 border px-2 py-0.5 font-mono text-[0.6875rem]', STATE_COLOR[rt.state])}>
            <span aria-hidden className={cn('inline-block size-1.5 rounded-full', STATE_BG[rt.state])} />
            {t(`runView.status.${rt.state}`)}
          </span>
        </div>
        <h2 className="text-[0.9375rem] font-medium">{t(`stage.${a.stage}`)}</h2>
        <p className="text-[0.8125rem] leading-relaxed text-muted-foreground">{t(`agents.${a.stage}.role`)}</p>
      </div>

      <dl className="grid grid-cols-3 border-b">
        {[
          [t('runView.model'), a.llm ? model : t('agents.noLlm')],
          [t('runView.input'), t(`agents.${a.stage}.input`)],
          [t('runView.output'), t(`agents.${a.stage}.output`)],
        ].map(([k, v], i) => (
          <div key={k} className={cn('flex min-w-0 flex-col gap-1 px-3 py-2.5', i < 2 && 'border-r')}>
            <dt className="label-mono text-[0.625rem]">{k}</dt>
            <dd className="text-xs [overflow-wrap:anywhere]">{v}</dd>
          </div>
        ))}
      </dl>

      <div className="relative flex h-40 items-center justify-center border-b">
        <span className={cn('label-mono absolute top-2.5 left-1/2 -translate-x-1/2 border px-2 py-0.5 whitespace-nowrap', STATE_COLOR[rt.state])}>
          {t('runView.state')} · {t(`runView.status.${rt.state}`)}
        </span>
        <AgentCube state={rt.state} short={a.short} />
      </div>

      <dl className="grid grid-cols-4 border-b">
        {stats.map(([k, v], i) => (
          <div key={k} className={cn('flex min-w-0 flex-col gap-1 px-3 py-2.5', i < 3 && 'border-r')}>
            <dt className="truncate font-mono text-[0.5625rem] tracking-wider text-muted-foreground uppercase">{k}</dt>
            <dd className="text-[0.9375rem] font-medium tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>

      <div className="flex flex-col gap-2.5 border-b px-4 py-3">
        <div className="flex justify-between">
          <span className="label-mono">{t('runView.task')}</span>
          <span className="font-mono text-xs">{Math.round(frac * 100)}%</span>
        </div>
        <div className="relative h-3.5">
          <span className="absolute inset-x-1.5 top-1.5 border-t border-dashed border-input" />
          <span className={cn('rc-smooth absolute top-1.5 left-1.5 h-px', STATE_BG[rt.state])} style={{ width: `calc((100% - 12px) * ${frac})` }} />
          <span className="absolute top-px left-0 size-3 rounded-full bg-accent-2 ring-3 ring-[var(--panel)]" />
          <span className={cn('absolute top-px right-0 size-3 rounded-full ring-3 ring-[var(--panel)]', rt.state === 'done' ? 'bg-teal' : 'bg-input')} />
        </div>
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>{t(`agents.${a.stage}.input`)}</span>
          <span>{t(`agents.${a.stage}.output`)}</span>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 px-4 py-3">
        <span className="label-mono">{t('runView.recent')}</span>
        {recent.length ? (
          <ul className="flex flex-col gap-1.5">
            {recent.map((e, i) => (
              <li key={`${e.ts}|${e.stage}|${e.message}|${e.current ?? ''}`} className="rc-fade grid grid-cols-[auto_1fr] gap-2.5 text-xs">
                <span className="font-mono text-muted-foreground">{timeOf(e.ts)}</span>
                <span className={i === 0 && rt.state === 'active' ? 'text-foreground' : 'text-muted-foreground'}>
                  {e.message || t(`stage.${e.stage}`)}
                  {e.total ? ` · ${e.current ?? 0}/${e.total}` : ''}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">{t('runView.noEvents')}</p>
        )}
      </div>
    </aside>
  )
}

function dedupe(events: ProgressEvent[]) {
  return events.filter((e, i) => i === 0 || e.message !== events[i - 1].message || e.stage !== events[i - 1].stage)
}
