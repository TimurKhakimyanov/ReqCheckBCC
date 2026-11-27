import { useQueryClient } from '@tanstack/react-query'
import { LogOut, Menu, X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { NavLink, Outlet, useLocation } from 'react-router'
import { api } from '@/api/client'
import { ME_KEY, useMe } from '@/app/auth'
import { Button } from '@/components/ui/button'
import { APP_VERSION, USE_MOCKS } from '@/shared/env'
import { cn } from '@/shared/utils'
import { LanguageSwitch, ThemeToggle } from './Preferences'

const NAV = [
  { to: '/documents', key: 'nav.documents' },
  { to: '/search', key: 'nav.search' },
  { to: '/agents', key: 'nav.agents' },
  { to: '/usage', key: 'nav.usage' },
  { to: '/audit', key: 'nav.audit' },
  { to: '/settings', key: 'nav.settings' },
] as const

/** Знак ReqCheck: квадрат с толстой рамкой, как в референсе. */
export function Brand({ className }: { className?: string }) {
  const { t } = useTranslation()
  return (
    <span className={cn('flex items-center gap-2.5 text-base font-semibold tracking-tight', className)}>
      <span aria-hidden className="inline-flex size-7 items-center justify-center rounded-[9px] bg-foreground">
        <span className="size-2.5 rounded-[3px] border-2 border-background" />
      </span>
      {t('app.name')}
    </span>
  )
}

function NavLinks({ onNavigate, vertical = false }: { onNavigate?: () => void; vertical?: boolean }) {
  const { t } = useTranslation()
  return (
    <>
      {NAV.map(({ to, key }) => (
        <NavLink
          key={to}
          to={to}
          onClick={onNavigate}
          className={({ isActive }) =>
            cn(
              'text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground',
              vertical ? 'mx-2 flex min-h-11 items-center rounded-xl px-3' : 'rounded-full px-3 py-1.5',
              isActive && 'bg-secondary font-medium text-foreground',
            )
          }
        >
          {t(key)}
        </NavLink>
      ))}
    </>
  )
}

function UserBlock({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation()
  const { data: me } = useMe()
  const qc = useQueryClient()
  const logout = async () => {
    await api.logout().catch(() => {})
    qc.clear()
    qc.setQueryData(ME_KEY, null)
  }
  return (
    <div className="flex items-center gap-1">
      <LanguageSwitch />
      <ThemeToggle />
      {!compact && (
        <span className="ml-1 hidden items-center gap-2 text-sm text-muted-foreground xl:flex" title={`v${APP_VERSION}`}>
          <span className="inline-flex size-7 items-center justify-center rounded-full bg-[#eef2ff] text-xs font-semibold text-[#3730a3] uppercase dark:bg-accent dark:text-foreground">
            {me?.username?.slice(0, 1)}
          </span>
          {me?.username}
        </span>
      )}
      <Button variant="ghost" size="icon-sm" onClick={logout} aria-label={t('auth.signOut')} title={t('auth.signOut')}>
        <LogOut />
      </Button>
    </div>
  )
}

export function AppShell() {
  const [open, setOpen] = useState(false)
  const { t } = useTranslation()
  const loc = useLocation()
  // Экран прогона и отчёта занимает всю высоту и сам управляет прокруткой панелей.
  const fullBleed = /^\/(runs\/|knowledge)/.test(loc.pathname)
  return (
    <div className="bg-dots flex h-full flex-col">
      <header className="shrink-0 px-3 pt-3 sm:px-4">
        <nav
          aria-label={t('nav.menu')}
          className="mx-auto flex h-14 max-w-[1440px] items-center justify-between gap-4 rounded-2xl bg-card px-3 shadow-card sm:px-4"
        >
          <NavLink to="/documents" className="shrink-0" aria-label={t('app.name')}>
            <Brand />
          </NavLink>
          <div className="hidden items-center gap-1 lg:flex">
            <NavLinks />
          </div>
          <div className="hidden lg:block">
            <UserBlock />
          </div>
          <Button variant="ghost" size="icon-sm" className="lg:hidden" onClick={() => setOpen(true)} aria-label={t('nav.menu')}>
            <Menu />
          </Button>
        </nav>
        {USE_MOCKS && (
          <div className="mx-auto mt-2 max-w-[1440px] rounded-xl bg-primary-tint px-3 py-1.5 text-xs text-foreground/80">
            {t('app.mockMode')}
          </div>
        )}
      </header>

      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-2 right-2 flex w-72 flex-col rounded-2xl bg-card shadow-raised">
            <div className="flex h-14 items-center justify-between px-4">
              <Brand />
              <Button variant="ghost" size="icon-sm" onClick={() => setOpen(false)} aria-label={t('common.close')}>
                <X />
              </Button>
            </div>
            <nav className="flex flex-col gap-0.5">
              <NavLinks vertical onNavigate={() => setOpen(false)} />
            </nav>
            <div className="mt-auto border-t p-3">
              <UserBlock compact />
            </div>
          </aside>
        </div>
      )}

      <main className={cn('min-h-0 flex-1', fullBleed ? 'overflow-hidden' : 'overflow-y-auto')}>
        {fullBleed ? (
          <Outlet />
        ) : (
          <div className="mx-auto min-h-full w-full max-w-7xl px-4 py-8 lg:px-10">
            <Outlet />
          </div>
        )}
      </main>
    </div>
  )
}
