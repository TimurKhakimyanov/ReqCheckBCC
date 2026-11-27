import type { ReactNode } from 'react'
import type { Severity } from '@/api/types'
import { cn } from '@/shared/utils'

/*
 * Мелкие общие детали страницы отчёта: прямые углы, тонкие рамки вместо теней,
 * моноширинные подписи капсом, цветной квадратик серьёзности. Цвета — только токены index.css.
 */

/** Моноширинная подпись раздела капсом: «ИТОГ», «ДЕФЕКТЫ ПО КРИТЕРИЯМ». */
export const EYEBROW = 'font-mono text-[11px] leading-4 font-medium uppercase tracking-[0.08em] text-muted-foreground'

export const SEV_BG: Record<Severity, string> = { critical: 'bg-sev-critical', major: 'bg-sev-major', minor: 'bg-sev-minor' }
export const SEV_TEXT: Record<Severity, string> = { critical: 'text-sev-critical', major: 'text-sev-major', minor: 'text-sev-minor' }
export const SEV_BORDER: Record<Severity, string> = { critical: 'border-sev-critical', major: 'border-sev-major', minor: 'border-sev-minor' }
export const SEV_TINT: Record<Severity, string> = { critical: 'bg-sev-critical-bg', major: 'bg-sev-major-bg', minor: 'bg-sev-minor-bg' }
export const SEV_VAR: Record<Severity, string> = { critical: 'var(--sev-critical)', major: 'var(--sev-major)', minor: 'var(--sev-minor)' }

export function SevSquare({ severity, className }: { severity: Severity; className?: string }) {
  return <span aria-hidden className={cn('inline-block size-[9px] shrink-0', SEV_BG[severity], className)} />
}

/** Белая панель с рамкой и подписью сверху. */
export function Panel({
  title,
  aside,
  children,
  className,
  as: Tag = 'section',
  ...rest
}: {
  title?: ReactNode
  aside?: ReactNode
  children: ReactNode
  className?: string
  as?: 'section' | 'div' | 'article'
  'aria-label'?: string
}) {
  return (
    <Tag className={cn('flex min-w-0 flex-col gap-3 border bg-card p-5', className)} {...rest}>
      {(title || aside) && (
        <div className="flex items-baseline justify-between gap-3">
          {title && <h3 className={EYEBROW}>{title}</h3>}
          {aside && <span className="font-mono text-xs text-muted-foreground">{aside}</span>}
        </div>
      )}
      {children}
    </Tag>
  )
}

/** Плашка-статус с рамкой цвета тона: «✓ Соответствует», «Блокирующий». */
export function TonePill({ tone, children, className }: { tone: 'ok' | 'bad' | 'warn' | 'info' | 'muted'; children: ReactNode; className?: string }) {
  const cls = {
    ok: 'border-teal text-teal',
    bad: 'border-sev-critical text-sev-critical',
    warn: 'border-sev-minor text-sev-minor',
    info: 'border-sev-major text-sev-major',
    muted: 'border-input text-muted-foreground',
  }[tone]
  return <span className={cn('inline-flex items-center gap-1.5 border px-2 py-0.5 font-mono text-xs whitespace-nowrap', cls, className)}>{children}</span>
}

/** Кнопка-фильтр «чип»: рамка, нажатое состояние — тёмная рамка и серый фон. */
export function FilterChip({
  pressed,
  onClick,
  children,
  className,
}: {
  pressed: boolean
  onClick: () => void
  children: ReactNode
  className?: string
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        'rc-focusable inline-flex min-h-9 cursor-pointer items-center gap-2 border px-3 text-[0.8125rem] transition-colors',
        pressed ? 'border-foreground bg-secondary' : 'border-input bg-card hover:border-foreground/40',
        className,
      )}
    >
      {children}
    </button>
  )
}
