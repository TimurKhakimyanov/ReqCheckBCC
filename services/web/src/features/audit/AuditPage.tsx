import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, ListTree, ScrollText, Search, Users } from 'lucide-react'
import { Fragment, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router'
import { api } from '@/api/client'
import type { AuditEntry } from '@/api/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input, NativeSelect } from '@/components/ui/input'
import { EmptyState, ErrorNote, PageHeader, Skeleton, Table, TBody, TD, TH, THead, TR } from '@/components/ui/misc'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { formatDate } from '@/shared/format'
import { cn } from '@/shared/utils'
import { RunLogsTab } from './RunLogTree'

const PAGE = 50
const TABS = ['runs', 'actions'] as const
type AuditTab = (typeof TABS)[number]

/** Цель действия — прогон (или дефект прогона «run/finding»)? Тогда из строки можно открыть его журнал. */
const runOf = (e: AuditEntry) => (/^(run|finding)[._]/.test(e.action) && e.target ? e.target.split('/')[0] : null)

function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms)
    return () => clearTimeout(id)
  }, [value, ms])
  return v
}

function ActionsTab({ onOpenRun }: { onOpenRun: (id: string) => void }) {
  const { t } = useTranslation()
  const [offset, setOffset] = useState(0)
  const [action, setAction] = useState('')
  const [q, setQ] = useState('')
  const query = useDebounced(q)
  const [open, setOpen] = useState<string | number | null>(null)
  useEffect(() => setOffset(0), [action, query])
  const log = useQuery({
    queryKey: ['audit', offset, action, query],
    queryFn: () => api.audit({ limit: PAGE, offset, ...(action ? { action } : {}), ...(query.trim() ? { q: query.trim() } : {}) }),
    placeholderData: keepPreviousData,
  })
  const total = log.data?.total ?? 0

  return (
    <>
      <div className="mb-3 flex flex-wrap gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('audit.searchActions')} className="pl-8" aria-label={t('audit.searchActions')} />
        </div>
        <NativeSelect value={action} onChange={(e) => setAction(e.target.value)} className="w-auto min-w-48" aria-label={t('audit.action')}>
          <option value="">{t('audit.allActions')}</option>
          {(log.data?.actions ?? []).map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </NativeSelect>
      </div>
      {log.error && <ErrorNote error={log.error} />}
      <Card>
        {log.isPending ? (
          <Skeleton className="m-4 h-40" />
        ) : !log.data?.items.length ? (
          <EmptyState icon={<ScrollText />} title={t('audit.empty')} />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH className="w-6" />
                <TH>{t('audit.ts')}</TH>
                <TH>{t('audit.actor')}</TH>
                <TH>{t('audit.action')}</TH>
                <TH>{t('audit.target')}</TH>
                <TH>{t('audit.details')}</TH>
              </TR>
            </THead>
            <TBody>
              {log.data.items.map((e) => {
                const expanded = open === e.id
                const run = runOf(e)
                return (
                  <Fragment key={e.id}>
                    <TR className="cursor-pointer" onClick={() => setOpen(expanded ? null : e.id)} aria-expanded={expanded}>
                      <TD className="pr-0">
                        <ChevronRight className={cn('size-4 text-muted-foreground transition-transform', expanded && 'rotate-90')} />
                      </TD>
                      <TD className="whitespace-nowrap text-muted-foreground">{formatDate(e.ts, { timeStyle: 'medium' })}</TD>
                      <TD>{e.actor}</TD>
                      <TD>
                        <Badge variant="outline" className="font-mono">
                          {e.action}
                        </Badge>
                      </TD>
                      <TD className="font-mono text-xs">{e.target ?? '—'}</TD>
                      <TD className="max-w-md truncate font-mono text-xs text-muted-foreground" title={details(e.details)}>
                        {details(e.details)}
                      </TD>
                    </TR>
                    {expanded && (
                      <TR className="hover:bg-transparent">
                        <TD />
                        <TD colSpan={5} className="pb-4">
                          <div className="rc-fade grid gap-2">
                            <pre className="max-h-64 overflow-auto rounded-lg bg-secondary/70 p-3 font-mono text-xs whitespace-pre-wrap">
                              {JSON.stringify(e.details ?? {}, null, 2)}
                            </pre>
                            <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                              {e.ip && (
                                <span>
                                  {t('audit.ip')}: <span className="font-mono">{e.ip}</span>
                                </span>
                              )}
                              {run && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={(ev) => {
                                    ev.stopPropagation()
                                    onOpenRun(run)
                                  }}
                                >
                                  <ListTree />
                                  {t('audit.openRunLog')}
                                </Button>
                              )}
                            </div>
                          </div>
                        </TD>
                      </TR>
                    )}
                  </Fragment>
                )
              })}
            </TBody>
          </Table>
        )}
      </Card>
      {total > PAGE && (
        <div className="mt-3 flex items-center justify-end gap-2 text-sm">
          <span className="text-muted-foreground">
            {offset + 1}–{Math.min(offset + PAGE, total)} / {total}
          </span>
          <Button variant="outline" size="icon-sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))} aria-label={t('common.prev')}>
            <ChevronLeft />
          </Button>
          <Button variant="outline" size="icon-sm" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)} aria-label={t('common.next')}>
            <ChevronRight />
          </Button>
        </div>
      )}
    </>
  )
}

export function AuditPage() {
  const { t } = useTranslation()
  const [params, setParams] = useSearchParams()
  const tab = (TABS.includes(params.get('tab') as AuditTab) ? params.get('tab') : 'runs') as AuditTab
  const update = (fn: (n: URLSearchParams) => void) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p)
        fn(n)
        return n
      },
      { replace: true },
    )
  const setTab = (v: string) => update((n) => (v === 'runs' ? n.delete('tab') : n.set('tab', v)))
  const openRun = (id: string) =>
    update((n) => {
      n.delete('tab')
      n.set('run', id)
    })

  return (
    <>
      <PageHeader title={t('audit.title')} description={t('audit.subtitle')} />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-5">
          <TabsTrigger value="runs">
            <ListTree className="size-4" />
            {t('audit.tabs.runs')}
          </TabsTrigger>
          <TabsTrigger value="actions">
            <Users className="size-4" />
            {t('audit.tabs.actions')}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="runs">
          <RunLogsTab runId={params.get('run')} onSelect={(id) => update((n) => n.set('run', id))} />
        </TabsContent>
        <TabsContent value="actions">
          <ActionsTab onOpenRun={openRun} />
        </TabsContent>
      </Tabs>
    </>
  )
}

function details(d: unknown): string {
  if (d === null || d === undefined) return ''
  if (typeof d === 'string') return d
  return Object.entries(d as Record<string, unknown>)
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(' ')
}
