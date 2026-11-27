import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '@/api/client'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { EmptyState, ErrorNote, PageHeader, Skeleton, Table, TBody, TD, TH, THead, TR } from '@/components/ui/misc'
import { formatDate } from '@/shared/format'

const PAGE = 50

export function AuditPage() {
  const { t } = useTranslation()
  const [offset, setOffset] = useState(0)
  const log = useQuery({
    queryKey: ['audit', offset],
    queryFn: () => api.audit({ limit: PAGE, offset }),
    placeholderData: keepPreviousData,
  })
  const total = log.data?.total ?? 0

  return (
    <>
      <PageHeader title={t('audit.title')} description={t('audit.subtitle')} />
      {log.error && <ErrorNote error={log.error} />}
      <Card>
        {log.isPending ? (
          <Skeleton className="m-4 h-40" />
        ) : !log.data?.items.length ? (
          <EmptyState title={t('audit.empty')} />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>{t('audit.ts')}</TH>
                <TH>{t('audit.actor')}</TH>
                <TH>{t('audit.action')}</TH>
                <TH>{t('audit.target')}</TH>
                <TH>{t('audit.details')}</TH>
              </TR>
            </THead>
            <TBody>
              {log.data.items.map((e) => (
                <TR key={e.id}>
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
              ))}
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

function details(d: unknown): string {
  if (d === null || d === undefined) return ''
  if (typeof d === 'string') return d
  return Object.entries(d as Record<string, unknown>)
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(' ')
}
