import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '@/api/client'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input, Label } from '@/components/ui/input'
import { ErrorNote, PageHeader, Skeleton, Table, TBody, TD, TH, THead, TR } from '@/components/ui/misc'
import { formatNumber, formatUsd } from '@/shared/format'

const iso = (d: Date) => d.toISOString().slice(0, 10)

export function UsagePage() {
  const { t } = useTranslation()
  const [from, setFrom] = useState(iso(new Date(Date.now() - 13 * 86_400_000)))
  const [to, setTo] = useState(iso(new Date()))
  const usage = useQuery({ queryKey: ['usage', from, to], queryFn: () => api.usage({ from, to }) })
  const u = usage.data
  const maxTokens = Math.max(1, ...(u?.by_day.map((d) => (d.prompt_tokens ?? 0) + (d.completion_tokens ?? 0)) ?? [1]))

  const Stat = ({ label, value }: { label: string; value: string }) => (
    <Card>
      <CardContent className="pt-5">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      </CardContent>
    </Card>
  )

  return (
    <>
      <PageHeader
        title={t('usage.title')}
        description={t('usage.subtitle')}
        actions={
          <div className="flex items-end gap-2">
            <div className="grid gap-1">
              <Label htmlFor="from" className="text-xs">
                {t('usage.from')}
              </Label>
              <Input id="from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8" />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="to" className="text-xs">
                {t('usage.to')}
              </Label>
              <Input id="to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-8" />
            </div>
          </div>
        }
      />
      {usage.error && <ErrorNote error={usage.error} />}
      {!u ? (
        <Skeleton className="h-64" />
      ) : (
        <div className="grid gap-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label={t('usage.calls')} value={formatNumber(u.totals.llm_calls)} />
            <Stat label={t('usage.promptTokens')} value={formatNumber(u.totals.prompt_tokens)} />
            <Stat label={t('usage.completionTokens')} value={formatNumber(u.totals.completion_tokens)} />
            <Stat label={t('usage.cost')} value={formatUsd(u.totals.cost_usd)} />
          </div>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('usage.byDay')}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex h-48 items-end gap-1" role="img" aria-label={t('usage.byDay')}>
                {u.by_day.map((d) => {
                  const p = d.prompt_tokens ?? 0
                  const c = d.completion_tokens ?? 0
                  return (
                    <div
                      key={d.day}
                      className="group relative flex h-full flex-1 flex-col justify-end"
                      title={`${d.day}: ${formatNumber(p + c)} ${t('usage.tokens')} · ${formatUsd(d.cost_usd)}`}
                    >
                      <div className="rounded-t-sm bg-primary/40" style={{ height: `${(c / maxTokens) * 100}%` }} />
                      <div className="bg-primary" style={{ height: `${(p / maxTokens) * 100}%` }} />
                    </div>
                  )
                })}
              </div>
              <div className="mt-2 flex justify-between text-xs text-muted-foreground">
                <span>{u.by_day[0]?.day}</span>
                <span className="flex gap-3">
                  <span className="flex items-center gap-1">
                    <span className="size-2 rounded-sm bg-primary" />
                    {t('usage.promptTokens')}
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="size-2 rounded-sm bg-primary/40" />
                    {t('usage.completionTokens')}
                  </span>
                </span>
                <span>{u.by_day.at(-1)?.day}</span>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('usage.byProvider')}</CardTitle>
            </CardHeader>
            <Table>
              <THead>
                <TR>
                  <TH>{t('launch.provider')}</TH>
                  <TH>{t('launch.model')}</TH>
                  <TH className="text-right">{t('usage.calls')}</TH>
                  <TH className="text-right">{t('usage.promptTokens')}</TH>
                  <TH className="text-right">{t('usage.completionTokens')}</TH>
                  <TH className="text-right">{t('usage.cost')}</TH>
                </TR>
              </THead>
              <TBody>
                {u.by_provider.map((p, i) => (
                  <TR key={i}>
                    <TD>{t(`provider.${p.provider}`, { defaultValue: p.provider })}</TD>
                    <TD className="font-mono text-xs">{p.model ?? '—'}</TD>
                    <TD className="text-right tabular-nums">{formatNumber(p.llm_calls)}</TD>
                    <TD className="text-right tabular-nums">{formatNumber(p.prompt_tokens)}</TD>
                    <TD className="text-right tabular-nums">{formatNumber(p.completion_tokens)}</TD>
                    <TD className="text-right tabular-nums">{formatUsd(p.cost_usd)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </Card>
        </div>
      )}
    </>
  )
}
