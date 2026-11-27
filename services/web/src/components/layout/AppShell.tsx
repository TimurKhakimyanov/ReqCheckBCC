import { useQueryClient } from '@tanstack/react-query'
import {
  BarChart3,
  BookOpen,
  FileText,
  LogOut,
  Menu,
  ScrollText,
  Search,
  Settings,
  ShieldCheck,
  X,
} from 'lucide-react'
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
  { to: '/documents', icon: FileText, key: 'nav.documents' },
  { to: '/search', icon: Search, key: 'nav.search' },
  { to: '/knowledge', icon: BookOpen, key: 'nav.knowledge' },
  { to: '/usage', icon: BarChart3, key: 'nav.usage' },
  { to: '/audit', icon: ScrollText, key: 'nav.audit' },
  { to: '/settings', icon: Settings, key: 'nav.settings' },
] as const

function Brand() {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-2 px-2 font-semibold">
      <span className="flex size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground">
        <ShieldCheck className="size-4" />
      </span>
      {t('app.name')}
    </div>
  )
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useTranslation()
  const { data: me } = useMe()
  const qc = useQueryClient()
  const logout = async () => {
    await api.logout().catch(() => {})
    qc.clear()
    qc.setQueryData(ME_KEY, null)
  }
  return (
    <div className="flex h-full flex-col gap-4 p-3">
      <Brand />
      <nav className="flex flex-1 flex-col gap-0.5">
        {NAV.map(({ to, icon: Icon, key }) => (
          <NavLink
            key={to}
            to={to}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground',
                isActive && 'bg-accent text-accent-foreground',
              )
            }
          >
            <Icon className="size-4" />
            {t(key)}
          </NavLink>
        ))}
      </nav>
      {USE_MOCKS && (
        <div className="rounded-md border border-dashed px-2.5 py-2 text-xs text-muted-foreground">{t('app.mockMode')}</div>
      )}
      <div className="flex items-center justify-between gap-1 border-t pt-3">
        <div className="min-w-0 px-1">
          <div className="truncate text-sm font-medium">{me?.username}</div>
          <div className="text-xs text-muted-foreground">v{APP_VERSION}</div>
        </div>
        <div className="flex items-center">
          <LanguageSwitch />
          <ThemeToggle />
          <Button variant="ghost" size="icon-sm" onClick={logout} aria-label={t('auth.signOut')} title={t('auth.signOut')}>
            <LogOut />
          </Button>
        </div>
      </div>
    </div>
  )
}

export function AppShell() {
  const [open, setOpen] = useState(false)
  const { t } = useTranslation()
  const loc = useLocation()
  // Экран отчёта занимает всю высоту и сам управляет прокруткой панелей.
  const fullBleed = /^\/runs\//.test(loc.pathname)
  return (
    <div className="flex h-full">
      <aside className="hidden w-60 shrink-0 border-r bg-sidebar text-sidebar-foreground lg:block">
        <SidebarContent />
      </aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-64 border-r bg-sidebar shadow-xl">
            <Button variant="ghost" size="icon-sm" className="absolute top-3 right-3" onClick={() => setOpen(false)} aria-label={t('common.close')}>
              <X />
            </Button>
            <SidebarContent onNavigate={() => setOpen(false)} />
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 items-center gap-2 border-b px-3 lg:hidden">
          <Button variant="ghost" size="icon-sm" onClick={() => setOpen(true)} aria-label={t('nav.menu')}>
            <Menu />
          </Button>
          <Brand />
        </header>
        <main className={cn('min-h-0 flex-1', fullBleed ? 'overflow-hidden' : 'overflow-y-auto')}>
          {fullBleed ? (
            <Outlet />
          ) : (
            <div className="mx-auto w-full max-w-6xl px-4 py-6 lg:px-8">
              <Outlet />
            </div>
          )}
        </main>
      </div>
    </div>
  )
}
