import { AlertTriangle, ChevronRight, Copy } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { cn } from '@/shared/utils'
import { describeProviderError, type ProviderErrorKind } from './providerError'

/** Куда вести пользователя для исправления */
const FIX_IN_SETTINGS: ProviderErrorKind[] = ['auth', 'forbidden', 'not_configured', 'not_found', 'quota', 'connection']
const FIX_IN_PARAMS: ProviderErrorKind[] = ['rate_limit', 'timeout', 'context', 'invalid_output']

/** Короткий заголовок ошибки провайдера — для таблиц и тостов. */
export function useProviderErrorTitle() {
  const { t } = useTranslation()
  return (raw: string | null | undefined) => t(`providerError.${describeProviderError(raw).kind}.title`)
}

/** Понятный текст ошибки провайдера + совет + раскрывающиеся подробности с исходным текстом. */
export function ProviderErrorNote({ raw, className, compact = false }: { raw: string; className?: string; compact?: boolean }) {
  const { t } = useTranslation()
  const info = describeProviderError(raw)
  const fixLink = FIX_IN_SETTINGS.includes(info.kind)
    ? '/settings'
    : FIX_IN_PARAMS.includes(info.kind)
      ? '/settings?tab=params'
      : null
  const showRaw = info.raw && info.raw !== t(`providerError.${info.kind}.title`)
  return (
    <div
      role="alert"
      data-kind={info.kind}
      className={cn('rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm', className)}
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
        <div className="grid min-w-0 gap-1">
          <p className="font-medium text-destructive">
            {t(`providerError.${info.kind}.title`)}
            {info.status ? <span className="ml-1.5 font-normal opacity-70">({info.status})</span> : null}
          </p>
          {!compact && <p className="text-foreground/80">{t(`providerError.${info.kind}.hint`)}</p>}
          {info.providerMessage && (
            <p className="text-foreground/80">
              <span className="text-muted-foreground">{t('providerError.providerSays')}: </span>
              {info.providerMessage}
            </p>
          )}
          {fixLink && !compact && (
            <Link to={fixLink} className="inline-flex w-fit items-center text-primary hover:underline">
              {t(fixLink === '/settings' ? 'providerError.openSettings' : 'providerError.openParams')}
              <ChevronRight className="size-4" />
            </Link>
          )}
          {showRaw && (
            <details className="group mt-1">
              <summary className="cursor-pointer text-xs text-muted-foreground select-none hover:text-foreground">
                {t('providerError.details')}
              </summary>
              <div className="relative mt-1.5">
                <pre className="max-h-48 overflow-auto rounded bg-background/70 p-2 pr-8 font-mono text-xs break-all whitespace-pre-wrap">
                  {info.raw}
                </pre>
                <button
                  type="button"
                  className="absolute top-1.5 right-1.5 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                  aria-label={t('common.copy')}
                  onClick={() => navigator.clipboard?.writeText(info.raw).then(() => toast.success(t('common.copied')))}
                >
                  <Copy className="size-3.5" />
                </button>
              </div>
            </details>
          )}
        </div>
      </div>
    </div>
  )
}
