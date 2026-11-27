import { useMutation, useQueryClient } from '@tanstack/react-query'
import { KeyRound, Pencil, Plus, Server, Unplug } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/api/client'
import type { ProviderId, ProviderSettings, ProviderUpdate } from '@/api/types'
import { isProviderConfigured } from '@/api/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { ErrorNote, Skeleton } from '@/components/ui/misc'
import { useProviders } from '@/features/runs/LaunchRunDialog'
import { formatDate } from '@/shared/format'
import { cn } from '@/shared/utils'
import { ProviderMark, ProviderWizard } from './ProviderWizard'

/** Милый робот, который ищет розетку: пустое состояние списка провайдеров. */
export function EmptyProvidersArt({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 240 150" className={cn('h-36 w-auto', className)} aria-hidden>
      {/* розетка */}
      <g transform="translate(184 64)">
        <circle r="20" fill="var(--primary-tint)" className="origin-center" style={{ animation: 'rc-ring 2.6s ease-out infinite', transformBox: 'fill-box' }} />
        <rect x="-15" y="-15" width="30" height="30" rx="8" fill="var(--card)" stroke="var(--border)" strokeWidth="2" />
        <rect x="-6" y="-6" width="3" height="8" rx="1.5" fill="var(--muted-foreground)" />
        <rect x="3" y="-6" width="3" height="8" rx="1.5" fill="var(--muted-foreground)" />
      </g>
      {/* провод с вилкой */}
      <path d="M96 96 C 128 130, 150 64, 160 64" fill="none" stroke="var(--primary)" strokeWidth="2.5" strokeLinecap="round" className="rc-spin-dash" />
      <g className="rc-plug">
        <rect x="156" y="57" width="12" height="14" rx="3" fill="var(--primary)" />
        <rect x="167" y="59.5" width="6" height="2.5" rx="1" fill="var(--primary)" />
        <rect x="167" y="66" width="6" height="2.5" rx="1" fill="var(--primary)" />
      </g>
      {/* робот */}
      <g className="rc-breath" style={{ transformBox: 'fill-box' }}>
        <line x1="70" y1="30" x2="70" y2="18" stroke="var(--border)" strokeWidth="3" strokeLinecap="round" />
        <circle cx="70" cy="15" r="5" fill="var(--primary)" style={{ animation: 'rc-live 1.6s ease-in-out infinite' }} />
        <rect x="36" y="30" width="68" height="54" rx="18" fill="var(--card)" stroke="var(--border)" strokeWidth="2.5" />
        <rect x="46" y="42" width="48" height="28" rx="12" fill="var(--secondary)" />
        <g className="rc-eyes" style={{ transformBox: 'fill-box', transformOrigin: 'center' }}>
          <circle cx="60" cy="56" r="4.5" fill="var(--foreground)" />
          <circle cx="80" cy="56" r="4.5" fill="var(--foreground)" />
        </g>
        <circle cx="52" cy="66" r="3" fill="var(--sev-major-bg)" />
        <circle cx="88" cy="66" r="3" fill="var(--sev-major-bg)" />
        <path d="M64 64 q6 4 12 0" fill="none" stroke="var(--foreground)" strokeWidth="2" strokeLinecap="round" />
        <rect x="50" y="86" width="40" height="22" rx="9" fill="var(--card)" stroke="var(--border)" strokeWidth="2.5" />
        <circle cx="70" cy="97" r="3.5" fill="var(--primary)" />
      </g>
      <ellipse cx="70" cy="134" rx="30" ry="4" fill="var(--muted)" className="rc-shadow" />
    </svg>
  )
}

function ProviderTile({ p, onEdit, index }: { p: ProviderSettings; onEdit: () => void; index: number }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const compat = p.provider === 'openai_compatible'
  const mut = useMutation({
    mutationFn: (body: ProviderUpdate) => api.updateProvider(p.provider, body),
    onSuccess: (np, body) => {
      qc.setQueryData<ProviderSettings[]>(['providers'], (xs) => xs?.map((x) => (x.provider === np.provider ? np : x)))
      void qc.invalidateQueries({ queryKey: ['models', p.provider] })
      if (!isProviderConfigured(np)) toast.success(t('wizard.disconnected', { name: t(`provider.${p.provider}`) }))
      else if (body.enabled !== undefined) toast.success(body.enabled ? t('wizard.enabledToast') : t('wizard.disabledToast'))
    },
    onError: (e) => toast.error(e.message),
  })
  const disconnect = () => {
    if (!window.confirm(t('wizard.confirmDisconnect', { name: t(`provider.${p.provider}`) }))) return
    mut.mutate(compat ? { base_url: '', api_key: '' } : { api_key: '' })
  }
  return (
    <Card className="flex flex-col gap-4 p-5" data-testid={`provider-${p.provider}`} style={{ animation: `rc-fade 0.5s ease ${index * 70}ms both` }}>
      <div className="flex items-start gap-3">
        <ProviderMark id={p.provider} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-medium">{t(`provider.${p.provider}`)}</h3>
            <Badge variant={p.enabled ? 'success' : 'secondary'} data-testid="provider-state">
              <span className={cn('size-1.5 rounded-full', p.enabled ? 'bg-success' : 'bg-muted-foreground')} />
              {p.enabled ? t('wizard.on') : t('wizard.off')}
            </Badge>
          </div>
          <p className="mt-1 flex items-center gap-1.5 truncate text-xs text-muted-foreground" data-testid="key-state">
            {compat ? <Server className="size-3.5 shrink-0" /> : <KeyRound className="size-3.5 shrink-0" />}
            <span className="truncate font-mono">{compat ? p.base_url : t('settings.keySet', { hint: p.key_hint ?? '' })}</span>
          </p>
        </div>
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted-foreground">{t('settings.defaultModel')}</dt>
        <dd className="truncate font-mono text-xs leading-5">{p.default_model ?? '—'}</dd>
        <dt className="text-muted-foreground">{t('wizard.steps.params')}</dt>
        <dd className="text-xs leading-5">
          {p.extra_body != null || p.extra_body_set_review != null || p.max_output_tokens != null || p.timeout_s != null
            ? t('settings.advanced.set')
            : t('wizard.defaults')}
        </dd>
      </dl>
      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t pt-3">
        <span className="text-xs text-muted-foreground">{p.updated_at ? t('settings.updated', { date: formatDate(p.updated_at) }) : ''}</span>
        <div className="flex gap-1">
          <Button type="button" variant="ghost" size="sm" disabled={mut.isPending} onClick={() => mut.mutate({ enabled: !p.enabled })}>
            {p.enabled ? t('wizard.disable') : t('wizard.enable')}
          </Button>
          <Button type="button" variant="ghost" size="icon-sm" onClick={disconnect} disabled={mut.isPending} aria-label={t('wizard.disconnect')} title={t('wizard.disconnect')}>
            <Unplug />
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={onEdit}>
            <Pencil />
            {t('wizard.edit')}
          </Button>
        </div>
      </div>
    </Card>
  )
}

export function ProvidersTab() {
  const { t } = useTranslation()
  const providers = useProviders()
  const [wizard, setWizard] = useState<{ open: boolean; initial: ProviderId | null }>({ open: false, initial: null })
  const all = providers.data ?? []
  const connected = all.filter(isProviderConfigured)
  const add = () => setWizard({ open: true, initial: null })

  return (
    <>
      {providers.error && <ErrorNote error={providers.error} />}
      {providers.isPending ? (
        <div className="grid gap-4 md:grid-cols-2">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-48 rounded-2xl" />
          ))}
        </div>
      ) : !connected.length ? (
        <Card className="rc-fade flex flex-col items-center gap-3 px-6 py-10 text-center" data-testid="providers-empty">
          <EmptyProvidersArt />
          <h3 className="text-lg font-medium">{t('wizard.emptyTitle')}</h3>
          <p className="max-w-md text-sm text-muted-foreground">{t('wizard.emptyHint')}</p>
          <Button type="button" onClick={add} className="mt-1">
            <Plus />
            {t('wizard.add')}
          </Button>
        </Card>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">{t('wizard.connectedCount', { count: connected.length, total: all.length })}</p>
            <Button type="button" onClick={add}>
              <Plus />
              {t('wizard.add')}
            </Button>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {connected.map((p, i) => (
              <ProviderTile key={p.provider} p={p} index={i} onEdit={() => setWizard({ open: true, initial: p.provider })} />
            ))}
          </div>
        </>
      )}
      <ProviderWizard
        open={wizard.open}
        initial={wizard.initial}
        providers={all}
        onOpenChange={(open) => setWizard((w) => ({ ...w, open }))}
      />
    </>
  )
}
