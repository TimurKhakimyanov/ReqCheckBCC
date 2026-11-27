import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Check, CircleX, Loader2, Play, Wifi, WifiOff } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { api } from '@/api/client'
import type { ProgressEvent, Run, RunStage } from '@/api/types'
import { isTerminal, PIPELINE_STAGES } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Progress, Spinner } from '@/components/ui/misc'
import { formatDate } from '@/shared/format'
import { cn } from '@/shared/utils'
import { LaunchRunDialog } from './LaunchRunDialog'
import { RunStatusBadge } from './RunBits'
import { useRunEvents } from './useRunEvents'

export function RunProgress({ run }: { run: Run }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [relaunch, setRelaunch] = useState(false)
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
  const currentIdx = PIPELINE_STAGES.indexOf(stage)
  // для упавшего прогона — последняя достигнутая стадия
  const reachedIdx = failed
    ? Math.max(0, ...events.filter((e) => !isTerminal(e.stage)).map((e) => PIPELINE_STAGES.indexOf(e.stage)))
    : currentIdx
  const log = dedupe(events)

  return (
    <div className="h-full overflow-y-auto">
    <div className="mx-auto w-full max-w-3xl px-4 py-6 lg:px-8">
      <Link to={`/documents/${run.document_id}`} className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" />
        {run.document_name}
      </Link>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{failed ? t('progress.titleFailed') : t('progress.title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t(`provider.${run.provider}`, { defaultValue: run.provider })} · {run.model} · {formatDate(run.created_at)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {!terminal && !failed && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground" title={t(`progress.stream.${state}`)}>
              {state === 'open' ? <Wifi className="size-3.5 text-success" /> : <WifiOff className="size-3.5" />}
              {t(`progress.stream.${state}`)}
            </span>
          )}
          {!failed && !terminal ? (
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
      </div>

      <Card>
        <CardContent className="grid gap-5 pt-5">
          <div className="grid gap-2">
            <div className="flex items-center justify-between text-sm">
              <RunStatusBadge status={stage} />
              <span className="font-medium tabular-nums">{Math.round(progress * 100)}%</span>
            </div>
            <Progress value={progress * 100} className={cn(failed && '[&>div]:bg-destructive')} />
            {message && !failed && <p className="text-sm text-muted-foreground">{message}</p>}
          </div>

          {failed && (run.error || message) && (
            <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              {run.error || message}
            </div>
          )}

          <ol className="grid gap-0" aria-label={t('progress.stages')}>
            {PIPELINE_STAGES.filter((s) => s !== 'done').map((s, i) => {
              const done = i < reachedIdx || stage === 'done'
              const active = i === reachedIdx && !done
              const errored = failed && i === reachedIdx
              const ev = [...events].reverse().find((e) => e.stage === s)
              return (
                <li key={s} className="flex gap-3" data-state={errored ? 'failed' : done ? 'done' : active ? 'active' : 'pending'}>
                  <div className="flex flex-col items-center">
                    <span
                      className={cn(
                        'flex size-6 items-center justify-center rounded-full border text-xs',
                        done && 'border-success bg-success text-success-foreground',
                        active && 'border-primary text-primary',
                        errored && 'border-destructive bg-destructive text-destructive-foreground',
                      )}
                    >
                      {errored ? <CircleX className="size-3.5" /> : done ? <Check className="size-3.5" /> : active ? <Loader2 className="size-3.5 animate-spin" /> : i + 1}
                    </span>
                    {i < PIPELINE_STAGES.length - 2 && <span className={cn('w-px flex-1', done ? 'bg-success' : 'bg-border')} />}
                  </div>
                  <div className="pb-4">
                    <div className={cn('text-sm font-medium', !done && !active && !errored && 'text-muted-foreground')}>{t(`stage.${s}`)}</div>
                    <div className="text-xs text-muted-foreground">
                      {t(`stageHint.${s}`)}
                      {active && ev?.total ? ` · ${ev.current ?? 0} / ${ev.total}` : ''}
                    </div>
                  </div>
                </li>
              )
            })}
          </ol>

          {log.length > 0 && (
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">{t('progress.log', { count: log.length })}</summary>
              <ul className="mt-2 max-h-48 overflow-y-auto rounded-md bg-muted/50 p-2 font-mono">
                {log.map((e, i) => (
                  <li key={i}>
                    <span className="text-muted-foreground">{new Date(e.ts).toLocaleTimeString()}</span> {e.stage}
                    {e.message ? ` — ${e.message}` : ''}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </CardContent>
      </Card>
      <LaunchRunDialog
        document={{ id: run.document_id, name: run.document_name, format: 'md', size_bytes: 0, sha256: '', created_at: run.created_at, runs_count: 0 }}
        open={relaunch}
        onOpenChange={setRelaunch}
      />
    </div>
    </div>
  )
}

function dedupe(events: ProgressEvent[]) {
  return events.filter((e, i) => i === 0 || e.message !== events[i - 1].message || e.stage !== events[i - 1].stage)
}
