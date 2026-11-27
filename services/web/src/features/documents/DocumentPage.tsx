import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Download, History, Play, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useParams } from 'react-router'
import { toast } from 'sonner'
import { api } from '@/api/client'
import { isTerminal } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState, ErrorNote, PageHeader, Skeleton, Table, TBody, TD, TH, THead, TR } from '@/components/ui/misc'
import { LaunchRunDialog } from '@/features/runs/LaunchRunDialog'
import { ReadinessBadge, RunStatusBadge, SeverityCounts } from '@/features/runs/RunBits'
import { downloadFile, formatBytes, formatDate, formatDuration } from '@/shared/format'

export function DocumentPage() {
  const { id = '' } = useParams()
  const { t } = useTranslation()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [launch, setLaunch] = useState(false)
  const doc = useQuery({ queryKey: ['documents', id], queryFn: () => api.document(id) })
  const runs = useQuery({
    queryKey: ['runs', { document_id: id }],
    queryFn: () => api.runs({ document_id: id, limit: 100 }),
    refetchInterval: (q) => (q.state.data?.items.some((r) => !isTerminal(r.status)) ? 3000 : false),
  })
  const del = useMutation({
    mutationFn: () => api.deleteDocument(id),
    onSuccess: () => {
      toast.success(t('documents.deleted'))
      void qc.invalidateQueries({ queryKey: ['documents'] })
      navigate('/documents')
    },
  })

  if (doc.error) return <ErrorNote error={doc.error} />
  if (!doc.data) return <Skeleton className="h-40" />
  const d = doc.data

  return (
    <>
      <Link to="/documents" className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" />
        {t('nav.documents')}
      </Link>
      <PageHeader
        title={d.name}
        description={`${d.format.toUpperCase()} · ${formatBytes(d.size_bytes)} · ${formatDate(d.created_at)}`}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => downloadFile(api.documentFileUrl(d.id), d.name).catch((e) => toast.error(e.message))}>
              <Download />
              {t('documents.download')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => window.confirm(t('documents.confirmDelete', { name: d.name })) && del.mutate()}
            >
              <Trash2 />
              {t('common.delete')}
            </Button>
            <Button size="sm" onClick={() => setLaunch(true)}>
              <Play />
              {t('documents.check')}
            </Button>
          </>
        }
      />
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <History className="size-4" />
            {t('documents.history')}
          </CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          {runs.isPending ? (
            <Skeleton className="mx-5 h-20" />
          ) : !runs.data?.items.length ? (
            <EmptyState title={t('documents.noRuns')} hint={t('documents.noRunsHint')} />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>{t('run.started')}</TH>
                  <TH>{t('run.status')}</TH>
                  <TH>{t('run.model')}</TH>
                  <TH>{t('documents.findings')}</TH>
                  <TH>{t('report.verdict')}</TH>
                  <TH>{t('run.duration')}</TH>
                </TR>
              </THead>
              <TBody>
                {runs.data.items.map((r) => (
                  <TR key={r.id} className="cursor-pointer" onClick={() => navigate(`/runs/${r.id}`)}>
                    <TD className="whitespace-nowrap">
                      <Link to={`/runs/${r.id}`} className="font-medium hover:underline" onClick={(e) => e.stopPropagation()}>
                        {formatDate(r.created_at)}
                      </Link>
                    </TD>
                    <TD>
                      <RunStatusBadge status={r.status} />
                      {r.error && <div className="mt-1 max-w-64 truncate text-xs text-destructive" title={r.error}>{r.error}</div>}
                    </TD>
                    <TD className="text-muted-foreground">
                      {t(`provider.${r.provider}`, { defaultValue: r.provider })} · {r.model}
                    </TD>
                    <TD>
                      <SeverityCounts summary={r.summary} />
                    </TD>
                    <TD>
                      <ReadinessBadge ready={r.summary?.ready_for_development} />
                    </TD>
                    <TD className="whitespace-nowrap text-muted-foreground">{formatDuration(r.usage?.duration_s)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <LaunchRunDialog document={d} open={launch} onOpenChange={setLaunch} />
    </>
  )
}
