import { useMutation } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate, useNavigate, useSearchParams } from 'react-router'
import { api, ApiError } from '@/api/client'
import { useMe, useSetMe } from '@/app/auth'
import { Brand } from '@/components/layout/AppShell'
import { LanguageSwitch, ThemeToggle } from '@/components/layout/Preferences'
import { Button } from '@/components/ui/button'
import { Input, Label } from '@/components/ui/input'
import { ErrorNote, Spinner } from '@/components/ui/misc'
import { ConveyorScene } from '@/features/runs/AgentScene'
import type { AgentState } from '@/features/runs/agents'
import { resources } from '@/i18n'
import { USE_MOCKS } from '@/shared/env'

export function LoginPage() {
  const { t, i18n } = useTranslation()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const setMe = useSetMe()
  const me = useMe()
  const [username, setUsername] = useState(USE_MOCKS ? 'admin' : '')
  const [password, setPassword] = useState(USE_MOCKS ? 'admin' : '')

  const login = useMutation({
    mutationFn: () => api.login(username.trim(), password),
    onSuccess: (user) => {
      setMe(user)
      if (user.locale && resources[user.locale] && !localStorage.getItem('reqcheck.lang')) void i18n.changeLanguage(user.locale)
      navigate(params.get('next') || '/documents', { replace: true })
    },
  })

  if (me.data) return <Navigate to={params.get('next') || '/documents'} replace />

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (username && password) login.mutate()
  }

  const error =
    login.error instanceof ApiError && login.error.status === 401 ? t('auth.invalid') : login.error ? login.error.message : null

  return (
    <div className="bg-dots flex min-h-full">
      <div className="mx-auto flex w-full max-w-[1440px] flex-wrap border-x">
        <div className="flex flex-[1_1_440px] flex-col gap-10 border-r bg-background/80 px-6 py-8 sm:px-14">
          <div className="flex items-center justify-between">
            <Brand />
            <div className="flex gap-1">
              <LanguageSwitch />
              <ThemeToggle />
            </div>
          </div>
          <div className="flex flex-1 flex-col justify-center gap-8">
            <div className="flex flex-col gap-4">
              <div className="label-mono flex items-center gap-2">
                <span aria-hidden className="inline-block size-1.5 bg-primary" />
                ISO 29148 · IEEE 830
              </div>
              <h1 className="text-[2.75rem] leading-[1.04] font-medium tracking-[-0.035em]">
                {t('auth.heroA')}
                <br />
                <span className="text-muted-foreground">{t('auth.heroB')}</span>
              </h1>
              <p className="text-[0.9375rem] text-muted-foreground">{t('auth.subtitle')}</p>
            </div>
            <form className="grid max-w-sm gap-4" onSubmit={submit}>
              <div className="grid gap-2">
                <Label htmlFor="username" className="label-mono">
                  {t('auth.username')}
                </Label>
                <Input
                  id="username"
                  className="h-11 font-mono"
                  autoComplete="username"
                  autoFocus
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="password" className="label-mono">
                  {t('auth.password')}
                </Label>
                <Input
                  id="password"
                  className="h-11 font-mono"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
              {error && <ErrorNote error={error} />}
              <Button type="submit" size="lg" className="mt-2 h-12" disabled={login.isPending || !username || !password}>
                {login.isPending && <Spinner />}
                {t('auth.signIn')}
              </Button>
              {USE_MOCKS && <p className="text-xs text-muted-foreground">{t('auth.mockHint')}</p>}
            </form>
          </div>
        </div>
        <div className="relative hidden min-h-[560px] flex-[1.3_1_520px] overflow-hidden lg:block" aria-hidden>
          <ConveyorScene states={DEMO_STATES} finished={false} />
        </div>
      </div>
    </div>
  )
}

const DEMO_STATES: AgentState[] = ['done', 'done', 'done', 'active', 'pending', 'pending', 'pending']
