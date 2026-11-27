import { useQueryClient } from '@tanstack/react-query'
import { Languages, Moon, Sun } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { api } from '@/api/client'
import type { User } from '@/api/types'
import { ME_KEY } from '@/app/auth'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { languages } from '@/i18n'
import { useTheme } from '@/theme/theme'

/** Смена языка: сразу в интерфейсе и (если вошли) сохраняется в профиле. */
export function useChangeLanguage() {
  const { i18n } = useTranslation()
  const qc = useQueryClient()
  return (code: string) => {
    void i18n.changeLanguage(code)
    const me = qc.getQueryData<User | null>(ME_KEY)
    if (me && me.locale !== code)
      api
        .updateMe({ locale: code })
        .then((u) => qc.setQueryData(ME_KEY, u))
        .catch(() => {})
  }
}

export function LanguageSwitch({ compact = true }: { compact?: boolean }) {
  const { t, i18n } = useTranslation()
  const change = useChangeLanguage()
  const current = languages.find((l) => l.code === i18n.resolvedLanguage) ?? languages[0]
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size={compact ? 'sm' : 'default'} aria-label={t('prefs.language')}>
          <Languages />
          <span className="uppercase">{current?.code}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={current?.code} onValueChange={change}>
          {languages.map((l) => (
            <DropdownMenuRadioItem key={l.code} value={l.code}>
              {l.name}
              {!l.ready && <span className="ml-auto text-xs text-muted-foreground">{t('prefs.beta')}</span>}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Одна кнопка: светлая ⇄ тёмная. Иконка показывает, на какую тему переключит нажатие. */
export function ThemeToggle() {
  const { t } = useTranslation()
  const { resolved, setMode } = useTheme()
  const next = resolved === 'dark' ? 'light' : 'dark'
  const label = next === 'dark' ? t('prefs.toDark') : t('prefs.toLight')
  const Icon = next === 'dark' ? Moon : Sun
  return (
    <Button variant="ghost" size="icon-sm" aria-label={label} title={label} onClick={() => setMode(next)} data-testid="theme-toggle">
      <Icon key={next} className="rc-spin-in" />
    </Button>
  )
}
