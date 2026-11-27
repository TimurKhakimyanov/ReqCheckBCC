import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/api/client'
import { useMe } from '@/app/auth'
import { useChangeLanguage } from '@/components/layout/Preferences'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input, Label, NativeSelect } from '@/components/ui/input'
import { ErrorNote, PageHeader, Skeleton, Spinner } from '@/components/ui/misc'
import { useProviders } from '@/features/runs/LaunchRunDialog'
import { languages } from '@/i18n'
import { useTheme, type ThemeMode } from '@/theme/theme'
import { ProviderCard } from './ProviderCard'

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
