import { useQuery } from '@tanstack/react-query'
import { FileText, Play, Search } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { api } from '@/api/client'
import type { DocumentItem } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { EmptyState, ErrorNote, PageHeader, Skeleton, Table, TBody, TD, TH, THead, TR } from '@/components/ui/misc'
import { LaunchRunDialog } from '@/features/runs/LaunchRunDialog'
import { RunStatusBadge, SeverityCounts } from '@/features/runs/RunBits'
import { formatBytes, formatRelative } from '@/shared/format'
import { UploadDropzone } from './UploadDropzone'

export function DocumentsPage() {
  const { t } = useTranslation()
  const [q, setQ] = useState('')
  const [launchFor, setLaunchFor] = useState<DocumentItem | null>(null)
  const docs = useQuery({
    queryKey: ['documents', { q }],
    queryFn: () => api.documents({ q, limit: 100 }),
    // пока идут прогоны — обновлять статусы
    refetchInterval: (query) =>
      query.state.data?.items.some((d) => d.last_run && !['done', 'failed', 'cancelled'].includes(d.last_run.status)) ? 3000 : false,
  })

  return (
    <>
      <PageHeader eyebrow="[ 01 ] ReqCheck" title={t('documents.title')} description={t('documents.subtitle')} />
      <UploadDropzone onUploaded={(doc) => setLaunchFor(doc)} />

      <div className="mt-8 mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-medium tracking-tight">{t('documents.list')}</h2>
        <div className="relative w-full sm:max-w-xs">
          <Search className="absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
          <Input className="pl-8" placeholder={t('documents.filter')} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>

      {docs.error && <ErrorNote error={docs.error} />}
      <Card>
        {docs.isPending ? (
          <div className="grid gap-2 p-4">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : docs.data?.items.length === 0 ? (
          <EmptyState icon={<FileText />} title={t('documents.empty')} hint={t('documents.emptyHint')} />
        ) : (
          <>
          {/* телефон: карточки вместо таблицы */}
          <ul className="divide-y sm:hidden" data-testid="documents-cards">
            {docs.data?.items.map((d) => (
              <li key={d.id} className="grid gap-2 p-4">
                <Link to={`/documents/${d.id}`} className="flex items-center gap-2 font-medium">
                  <FileText className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">{d.name}</span>
                </Link>
                <div className="text-xs text-muted-foreground">
                  {d.format.toUpperCase()} · {formatBytes(d.size_bytes)} · {formatRelative(d.created_at)}
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {d.last_run && (
                    <Link to={`/runs/${d.last_run.id}`}>
                      <RunStatusBadge status={d.last_run.status} />
                    </Link>
                  )}
                  <SeverityCounts summary={d.last_run?.summary} />
                </div>
                <Button size="sm" variant="outline" className="justify-self-start" onClick={() => setLaunchFor(d)}>
                  <Play />
                  {t('documents.check')}
                </Button>
              </li>
            ))}
          </ul>
          <div className="hidden sm:block">
          <Table>
            <THead>
              <TR>
                <TH>{t('documents.name')}</TH>
                <TH>{t('documents.uploaded')}</TH>
                <TH>{t('documents.lastRun')}</TH>
                <TH>{t('documents.findings')}</TH>
                <TH className="w-0" />
              </TR>
            </THead>
            <TBody>
              {docs.data?.items.map((d) => (
                <TR key={d.id}>
                  <TD>
                    <Link to={`/documents/${d.id}`} className="flex items-center gap-2 font-medium hover:underline">
                      <FileText className="size-4 shrink-0 text-muted-foreground" />
                      <span className="truncate">{d.name}</span>
                    </Link>
                    <div className="mt-0.5 pl-6 text-xs text-muted-foreground">
                      {d.format.toUpperCase()} · {formatBytes(d.size_bytes)} · {t('documents.runsCount', { count: d.runs_count })}
                    </div>
                  </TD>
                  <TD className="whitespace-nowrap text-muted-foreground">{formatRelative(d.created_at)}</TD>
                  <TD>
                    {d.last_run ? (
                      <Link to={`/runs/${d.last_run.id}`} className="inline-flex flex-col gap-1 hover:opacity-80">
                        <RunStatusBadge status={d.last_run.status} />
                        <span className="text-xs text-muted-foreground">
                          {d.last_run.model ?? formatRelative(d.last_run.finished_at ?? d.last_run.created_at)}
                        </span>
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TD>
                  <TD>
                    <SeverityCounts summary={d.last_run?.summary} />
                  </TD>
                  <TD>
                    <Button size="sm" variant="outline" onClick={() => setLaunchFor(d)}>
                      <Play />
                      {t('documents.check')}
                    </Button>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
          </div>
          </>
        )}
      </Card>
      <LaunchRunDialog document={launchFor} open={!!launchFor} onOpenChange={(v) => !v && setLaunchFor(null)} />
    </>
  )
}
