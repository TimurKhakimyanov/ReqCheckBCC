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
import { EmptyState, ErrorNote, Skeleton, Table, TBody, TD, TH, THead, TR } from '@/components/ui/misc'
import { LaunchRunDialog } from '@/features/runs/LaunchRunDialog'
import { RunStatusBadge, SeverityCounts } from '@/features/runs/RunBits'
import { formatBytes, formatRelative } from '@/shared/format'
import { cn } from '@/shared/utils'
import { UploadDropzone } from './UploadDropzone'

const FORMAT_TONE: Record<DocumentItem['format'], string> = {
  pdf: 'text-primary',
  docx: 'text-accent-2',
  md: 'text-teal',
  txt: 'text-muted-foreground',
}

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
      <section className="mb-10 grid items-stretch gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <div className="flex flex-col justify-center gap-5 py-2">
          <div className="inline-flex items-center gap-2.5 self-start border px-1 py-1 pr-3 font-mono text-xs tracking-wider text-muted-foreground uppercase">
            <span className="bg-primary px-1.5 py-0.5 font-semibold text-[#16161A]">29148</span>
            ISO/IEC/IEEE 29148 · IEEE 830
          </div>
          <h1 className="text-5xl leading-[1.02] font-medium tracking-[-0.035em] sm:text-6xl">
            {t('documents.heroA')}
            <br />
            <span className="text-muted-foreground">{t('documents.heroB')}</span>
          </h1>
          <p className="max-w-md text-[0.9375rem] leading-relaxed text-muted-foreground">{t('documents.subtitle')}</p>
          <ul className="grid gap-3 font-mono text-sm">
            {(['documents.point1', 'documents.point2', 'documents.point3'] as const).map((k) => (
              <li key={k} className="flex items-center gap-3">
                <span aria-hidden className="inline-flex size-4 items-center justify-center border border-muted-foreground text-[10px]">
                  ↗
                </span>
                {t(k)}
              </li>
            ))}
          </ul>
        </div>
        <UploadDropzone onUploaded={(doc) => setLaunchFor(doc)} />
      </section>

      <div className="mt-8 mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="label-mono flex items-center gap-2">
          <span aria-hidden className="inline-block size-1.5 bg-primary" />
          {t('documents.list')}
        </h2>
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
                    <div className="flex items-center gap-3">
                      <span className={cn('flex size-10 shrink-0 items-center justify-center border font-mono text-[0.625rem]', FORMAT_TONE[d.format])}>
                        {d.format.toUpperCase()}
                      </span>
                      <div className="min-w-0">
                        <Link to={`/documents/${d.id}`} className="block truncate font-medium hover:underline">
                          {d.name}
                        </Link>
                        <div className="mt-0.5 font-mono text-xs text-muted-foreground">
                          {formatBytes(d.size_bytes)} · {t('documents.runsCount', { count: d.runs_count })}
                        </div>
                      </div>
                    </div>
                  </TD>
                  <TD className="font-mono text-xs whitespace-nowrap text-muted-foreground">{formatRelative(d.created_at)}</TD>
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
