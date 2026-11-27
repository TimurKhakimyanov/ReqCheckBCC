import { useMutation } from '@tanstack/react-query'
import { ShieldCheck } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate, useNavigate, useSearchParams } from 'react-router'
import { api, ApiError } from '@/api/client'
import { useMe, useSetMe } from '@/app/auth'
import { LanguageSwitch, ThemeToggle } from '@/components/layout/Preferences'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input, Label } from '@/components/ui/input'
import { ErrorNote, Spinner } from '@/components/ui/misc'
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
    <div className="flex min-h-full flex-col bg-muted/40">
      <div className="flex justify-end gap-1 p-3">
        <LanguageSwitch />
        <ThemeToggle />
      </div>
      <div className="flex flex-1 items-center justify-center p-4 pb-24">
        <Card className="w-full max-w-sm">
          <CardHeader className="items-center text-center">
            <div className="mb-2 flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              <ShieldCheck className="size-6" />
            </div>
            <CardTitle className="text-xl">{t('app.name')}</CardTitle>
            <CardDescription>{t('auth.subtitle')}</CardDescription>
          </CardHeader>
          <CardContent>
            <form className="grid gap-4" onSubmit={submit}>
              <div className="grid gap-2">
                <Label htmlFor="username">{t('auth.username')}</Label>
                <Input id="username" autoComplete="username" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} required />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="password">{t('auth.password')}</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
              {error && <ErrorNote error={error} />}
              <Button type="submit" disabled={login.isPending || !username || !password}>
                {login.isPending && <Spinner />}
                {t('auth.signIn')}
              </Button>
              {USE_MOCKS && <p className="text-center text-xs text-muted-foreground">{t('auth.mockHint')}</p>}
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
