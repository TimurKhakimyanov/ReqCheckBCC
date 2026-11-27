import { useMutation, useQueryClient } from '@tanstack/react-query'
import { KeyRound, PlugZap, Save } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/api/client'
import type { ProviderSettings, ProviderTestResult } from '@/api/types'
import { useMe } from '@/app/auth'
import { useChangeLanguage } from '@/components/layout/Preferences'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox, Input, Label, NativeSelect } from '@/components/ui/input'
import { ErrorNote, PageHeader, Skeleton, Spinner } from '@/components/ui/misc'
import { useModels, useProviders } from '@/features/runs/LaunchRunDialog'
import { languages } from '@/i18n'
import { formatDate } from '@/shared/format'
import { useTheme, type ThemeMode } from '@/theme/theme'

function ProviderCard({ p }: { p: ProviderSettings }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(p.base_url ?? '')
  const [enabled, setEnabled] = useState(p.enabled)
  const [model, setModel] = useState(p.default_model ?? '')
  const [test, setTest] = useState<ProviderTestResult | null>(null)
  const models = useModels(p.provider)

  const save = useMutation({
    mutationFn: (body: Parameters<typeof api.updateProvider>[1]) => api.updateProvider(p.provider, body),
    onSuccess: (np) => {
      qc.setQueryData<ProviderSettings[]>(['providers'], (xs) => xs?.map((x) => (x.provider === np.provider ? np : x)))
      void qc.invalidateQueries({ queryKey: ['models', p.provider] })
      setApiKey('')
      toast.success(t('settings.saved'))
    },
    onError: (e) => toast.error(e.message),
  })
  const check = useMutation({ mutationFn: () => api.testProvider(p.provider), onSuccess: setTest, onError: (e) => setTest({ ok: false, latency_ms: 0, error: e.message }) })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    save.mutate({
      enabled,
      default_model: model,
      ...(apiKey ? { api_key: apiKey } : {}),
      ...(p.provider === 'openai_compatible' ? { base_url: baseUrl } : {}),
    })
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>{t(`provider.${p.provider}`)}</CardTitle>
          {p.has_key ? (
            <Badge variant="success">
              <KeyRound />
              {p.key_hint}
            </Badge>
          ) : (
            <Badge variant="secondary">{t('settings.noKey')}</Badge>
          )}
        </div>
        <CardDescription>{t(`settings.providerHint.${p.provider}`)}</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-3" onSubmit={submit}>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            {t('settings.enabled')}
          </label>
          <div className="grid gap-1.5">
            <Label htmlFor={`key-${p.provider}`}>{t('settings.apiKey')}</Label>
            <Input
              id={`key-${p.provider}`}
              type="password"
              autoComplete="off"
              placeholder={p.has_key ? t('settings.keyKeep', { hint: p.key_hint }) : t('settings.keyEnter')}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </div>
          {p.provider === 'openai_compatible' && (
            <div className="grid gap-1.5">
              <Label htmlFor={`url-${p.provider}`}>{t('settings.baseUrl')}</Label>
              <Input id={`url-${p.provider}`} value={baseUrl} placeholder="http://ollama:11434/v1" onChange={(e) => setBaseUrl(e.target.value)} />
            </div>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor={`model-${p.provider}`}>{t('settings.defaultModel')}</Label>
            <NativeSelect id={`model-${p.provider}`} value={model} onChange={(e) => setModel(e.target.value)}>
              {!models.data?.includes(model) && <option value={model}>{model || '—'}</option>}
              {models.data?.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </NativeSelect>
          </div>
          {test && (
            <div className={`rounded-md px-3 py-2 text-sm ${test.ok ? 'bg-success/10 text-success' : 'bg-destructive/10 text-destructive'}`}>
              {test.ok ? t('settings.testOk', { ms: test.latency_ms }) : t('settings.testFail', { error: test.error ?? '' })}
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">
              {p.updated_at ? t('settings.updated', { date: formatDate(p.updated_at) }) : ''}
            </span>
            <div className="flex gap-2">
              {p.has_key && (
                <Button type="button" variant="ghost" size="sm" onClick={() => window.confirm(t('settings.confirmRemoveKey')) && save.mutate({ api_key: '' })}>
                  {t('settings.removeKey')}
                </Button>
              )}
              <Button type="button" variant="outline" size="sm" onClick={() => check.mutate()} disabled={check.isPending}>
                {check.isPending ? <Spinner /> : <PlugZap />}
                {t('settings.test')}
              </Button>
              <Button type="submit" size="sm" disabled={save.isPending}>
                {save.isPending ? <Spinner /> : <Save />}
                {t('common.save')}
              </Button>
            </div>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

function PasswordCard() {
  const { t } = useTranslation()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [repeat, setRepeat] = useState('')
  const mut = useMutation({
    mutationFn: () => api.updateMe({ password: { current, new: next } }),
    onSuccess: () => {
      toast.success(t('settings.passwordChanged'))
      setCurrent('')
      setNext('')
      setRepeat('')
    },
  })
  const mismatch = repeat.length > 0 && next !== repeat
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settings.password')}</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (!mismatch) mut.mutate()
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="pw-cur">{t('settings.currentPassword')}</Label>
            <Input id="pw-cur" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="pw-new">{t('settings.newPassword')}</Label>
            <Input id="pw-new" type="password" autoComplete="new-password" minLength={8} value={next} onChange={(e) => setNext(e.target.value)} required />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="pw-rep">{t('settings.repeatPassword')}</Label>
            <Input id="pw-rep" type="password" autoComplete="new-password" aria-invalid={mismatch} value={repeat} onChange={(e) => setRepeat(e.target.value)} required />
            {mismatch && <span className="text-xs text-destructive">{t('settings.mismatch')}</span>}
          </div>
          {mut.error && <ErrorNote error={mut.error} />}
          <div className="flex justify-end">
            <Button type="submit" disabled={mut.isPending || mismatch || !current || next.length < 8}>
              {mut.isPending && <Spinner />}
              {t('settings.changePassword')}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

function ProfileCard() {
  const { t, i18n } = useTranslation()
  const { data: me } = useMe()
  const change = useChangeLanguage()
  const { mode, setMode } = useTheme()
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settings.profile')}</CardTitle>
        <CardDescription>
          {me?.username} · {t('settings.roleAdmin')}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="lang">{t('prefs.language')}</Label>
          <NativeSelect id="lang" value={i18n.resolvedLanguage} onChange={(e) => change(e.target.value)}>
            {languages.map((l) => (
              <option key={l.code} value={l.code}>
                {l.name}
                {!l.ready ? ` (${t('prefs.beta')})` : ''}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="theme">{t('prefs.theme')}</Label>
          <NativeSelect id="theme" value={mode} onChange={(e) => setMode(e.target.value as ThemeMode)}>
            <option value="light">{t('prefs.light')}</option>
            <option value="dark">{t('prefs.dark')}</option>
            <option value="system">{t('prefs.system')}</option>
          </NativeSelect>
        </div>
      </CardContent>
    </Card>
  )
}

export function SettingsPage() {
  const { t } = useTranslation()
  const providers = useProviders()
  return (
    <>
      <PageHeader title={t('settings.title')} description={t('settings.subtitle')} />
      <h2 className="mb-3 text-lg font-semibold">{t('settings.providers')}</h2>
      {providers.error && <ErrorNote error={providers.error} />}
      <div className="grid gap-4 md:grid-cols-2">
        {providers.isPending
          ? [0, 1].map((i) => <Skeleton key={i} className="h-72" />)
          : providers.data?.map((p) => <ProviderCard key={`${p.provider}-${p.updated_at}`} p={p} />)}
      </div>
      <h2 className="mt-8 mb-3 text-lg font-semibold">{t('settings.account')}</h2>
      <div className="grid gap-4 md:grid-cols-2">
        <ProfileCard />
        <PasswordCard />
      </div>
    </>
  )
}
