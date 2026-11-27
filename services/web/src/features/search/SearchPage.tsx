import { useQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useSearchParams } from 'react-router'
import { api } from '@/api/client'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input, NativeSelect } from '@/components/ui/input'
import { EmptyState, ErrorNote, PageHeader, Skeleton } from '@/components/ui/misc'

export function SearchPage() {
  const { t } = useTranslation()
  const [params, setParams] = useSearchParams()
  const q = params.get('q') ?? ''
  const kind = (params.get('kind') ?? '') as '' | 'requirement' | 'finding'
  const [draft, setDraft] = useState(q)
  useEffect(() => setDraft(q), [q])

  const res = useQuery({
    queryKey: ['search', q, kind],
    queryFn: () => api.search({ q, kind: kind || undefined, limit: 30 }),
    enabled: q.trim().length > 1,
  })

  const update = (next: { q?: string; kind?: string }) => {
    const p = new URLSearchParams(params)
    for (const [k, v] of Object.entries(next)) {
      if (v) p.set(k, v)
      else p.delete(k)
    }
    setParams(p, { replace: true })
  }

  return (
    <>
      <PageHeader title={t('search.title')} description={t('search.subtitle')} />
      <form
        className="mb-6 flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          update({ q: draft.trim() })
        }}
      >
        <div className="relative min-w-64 flex-1">
          <Search className="absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
          <Input className="pl-8" autoFocus placeholder={t('search.placeholder')} value={draft} onChange={(e) => setDraft(e.target.value)} />
        </div>
        <NativeSelect className="w-48" aria-label={t('search.kind')} value={kind} onChange={(e) => update({ kind: e.target.value })}>
          <option value="">{t('search.all')}</option>
          <option value="requirement">{t('search.requirements')}</option>
          <option value="finding">{t('search.findings')}</option>
        </NativeSelect>
        <Button type="submit">{t('search.go')}</Button>
      </form>

      {res.error && <ErrorNote error={res.error} />}
      {!q ? (
        <EmptyState icon={<Search />} title={t('search.hint')} />
      ) : res.isPending ? (
        <div className="grid gap-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
      ) : !res.data?.length ? (
        <EmptyState title={t('search.nothing')} />
      ) : (
        <div className="grid gap-2">
          {res.data.map((h, i) => (
            <Card key={i} className="p-4">
              <div className="mb-1.5 flex flex-wrap items-center gap-2 text-xs">
                <Badge variant={h.kind === 'finding' ? 'warning' : 'secondary'}>
                  {h.kind === 'finding' ? t('search.finding') : t('search.requirement')}
                </Badge>
                <span className="font-mono">{h.finding_id ?? h.requirement_id}</span>
                <span className="text-muted-foreground">· {h.document_name}</span>
                <span className="ml-auto text-muted-foreground tabular-nums" title={t('search.score')}>
                  {(h.score * 100).toFixed(0)}%
                </span>
              </div>
              <p className="text-sm">{h.text}</p>
              <Link
                className="mt-2 inline-block text-sm text-primary hover:underline"
                to={`/runs/${h.run_id}${h.finding_id ? `?finding=${encodeURIComponent(h.finding_id)}` : '?tab=requirements'}`}
              >
                {t('search.open')}
              </Link>
            </Card>
          ))}
        </div>
      )}
    </>
  )
}
