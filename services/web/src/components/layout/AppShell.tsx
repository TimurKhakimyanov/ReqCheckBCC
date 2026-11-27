import { useQueryClient } from '@tanstack/react-query'
import {
  BarChart3,
  BookOpen,
  FileText,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
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

function Brand({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-2 px-1.5 font-medium tracking-tight">
      <span className="flex size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-primary">
        <ShieldCheck className="size-4" />
      </span>
      {!compact && t('app.name')}
    </div>
  )
}

function SidebarContent({ onNavigate, compact = false, onToggle }: { onNavigate?: () => void; compact?: boolean; onToggle?: () => void }) {
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
      <div className={cn('flex items-center', compact ? 'flex-col gap-2' : 'justify-between')}>
        <Brand compact={compact} />
        {onToggle && (
          <Button variant="ghost" size="icon-sm" onClick={onToggle} aria-label={t(compact ? 'nav.expand' : 'nav.collapse')} title={t(compact ? 'nav.expand' : 'nav.collapse')}>
            {compact ? <PanelLeftOpen /> : <PanelLeftClose />}
          </Button>
        )}
      </div>
      <nav className="flex flex-1 flex-col gap-1">
        {!compact && <div className="label-mono px-2.5 pt-2 pb-1">[ ReqCheck ]</div>}
        {NAV.map(({ to, icon: Icon, key }) => (
          <NavLink
            key={to}
            to={to}
            onClick={onNavigate}
            title={compact ? t(key) : undefined}
            aria-label={compact ? t(key) : undefined}
            className={({ isActive }) =>
              cn(
                'press flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-foreground/75 hover:bg-accent hover:text-foreground',
                compact && 'justify-center',
                isActive && 'bg-card font-[450] text-foreground shadow-card hover:bg-card dark:bg-accent [&_svg]:text-primary',
              )
            }
          >
            <Icon className="size-4" />
            {!compact && t(key)}
          </NavLink>
        ))}
      </nav>
      {USE_MOCKS && !compact && (
        <div className="rounded-lg border border-dashed border-primary/40 bg-primary-tint px-2.5 py-2 text-xs text-foreground/80">{t('app.mockMode')}</div>
      )}
      <div className={cn('flex items-center justify-between gap-1 border-t pt-3', compact && 'flex-col')}>
        {!compact && (
          <div className="min-w-0 px-1">
            <div className="truncate text-sm font-medium">{me?.username}</div>
            <div className="text-xs text-muted-foreground">v{APP_VERSION}</div>
          </div>
        )}
        <div className={cn('flex items-center', compact && 'flex-col')}>
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

const COLLAPSE_KEY = 'reqcheck.sidebar.collapsed'

export function AppShell() {
  const [open, setOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === '1'
    } catch {
      return false
    }
  })
  const toggle = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1')
      } catch {
        /* ignore */
      }
      return !c
    })
  const { t } = useTranslation()
  const loc = useLocation()
  // Экран отчёта занимает всю высоту и сам управляет прокруткой панелей.
  const fullBleed = /^\/runs\//.test(loc.pathname)
  return (
    <div className="flex h-full">
      <aside className={cn('hidden shrink-0 border-r bg-sidebar text-sidebar-foreground lg:block', collapsed ? 'w-16' : 'w-60')}>
        <SidebarContent compact={collapsed} onToggle={toggle} />
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
        <header className="flex h-12 items-center gap-2 border-b bg-background/90 px-3 backdrop-blur lg:hidden">
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
