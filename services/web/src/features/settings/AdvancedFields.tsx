import { ChevronRight, Wand2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ProviderSettings, ProviderUpdate } from '@/api/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input, Label, Textarea } from '@/components/ui/input'
import { cn } from '@/shared/utils'
import {
  formatJson,
  MAX_OUTPUT_TOKENS_LIMIT,
  parseJsonObject,
  TIMEOUT_DEFAULT_S,
  TIMEOUT_LIMITS,
  VLLM_THINKING_PRESET,
} from './advanced'

export interface AdvancedDraft {
  extraBody: string
  extraBodySetReview: string
  maxTokens: string
  timeoutS: string
}

export const advancedFrom = (p: ProviderSettings): AdvancedDraft => ({
  extraBody: formatJson(p.extra_body),
  extraBodySetReview: formatJson(p.extra_body_set_review),
  maxTokens: p.max_output_tokens == null ? '' : String(p.max_output_tokens),
  timeoutS: p.timeout_s == null ? '' : String(p.timeout_s),
})

/** Проверка и перевод черновика в поля PUT /providers/{p}. errors — ключи перевода по полям. */
export function advancedToUpdate(d: AdvancedDraft): { update: ProviderUpdate; errors: Partial<Record<keyof AdvancedDraft, string>> } {
  const errors: Partial<Record<keyof AdvancedDraft, string>> = {}
  const eb = parseJsonObject(d.extraBody)
  const ebr = parseJsonObject(d.extraBodySetReview)
  if (eb.error) errors.extraBody = eb.error === 'invalid' ? `invalid:${eb.detail ?? ''}` : 'not_object'
  if (ebr.error) errors.extraBodySetReview = ebr.error === 'invalid' ? `invalid:${ebr.detail ?? ''}` : 'not_object'
  const raw = d.maxTokens.trim()
  const n = raw === '' ? null : Number(raw)
  if (n !== null && (!Number.isInteger(n) || n < 1 || n > MAX_OUTPUT_TOKENS_LIMIT)) errors.maxTokens = 'range'
  const rawT = d.timeoutS.trim()
  const tm = rawT === '' ? null : Number(rawT)
  if (tm !== null && (!Number.isInteger(tm) || tm < TIMEOUT_LIMITS.min || tm > TIMEOUT_LIMITS.max)) errors.timeoutS = 'timeout'
  return {
    update: { extra_body: eb.value, extra_body_set_review: ebr.value, max_output_tokens: n, timeout_s: tm },
    errors,
  }
}

export function AdvancedFields({
  id,
  draft,
  onChange,
  defaultOpen,
}: {
  id: string
  draft: AdvancedDraft
  onChange: (d: AdvancedDraft) => void
  defaultOpen?: boolean
}) {
  const { t } = useTranslation()
  const { errors } = advancedToUpdate(draft)
  const msg = (e?: string) =>
    !e
      ? null
      : e === 'not_object'
        ? t('settings.advanced.jsonNotObject')
        : e === 'range'
          ? t('settings.advanced.tokensRange', { max: MAX_OUTPUT_TOKENS_LIMIT.toLocaleString() })
          : e === 'timeout'
            ? t('settings.advanced.timeoutRange', TIMEOUT_LIMITS)
          : t('settings.advanced.jsonInvalid', { detail: e.replace(/^invalid:/, '') })
  const filled = !!(draft.extraBody.trim() || draft.extraBodySetReview.trim() || draft.maxTokens.trim() || draft.timeoutS.trim())

  const field = (key: 'extraBody' | 'extraBodySetReview', label: string, hint: string, placeholder: string) => (
    <div className="grid gap-1.5">
      <Label htmlFor={`${id}-${key}`}>{label}</Label>
      <Textarea
        id={`${id}-${key}`}
        rows={3}
        spellCheck={false}
        className="font-mono text-xs"
        placeholder={placeholder}
        value={draft[key]}
        aria-invalid={!!errors[key]}
        onChange={(e) => onChange({ ...draft, [key]: e.target.value })}
        onBlur={() => {
          // аккуратно отформатировать валидный JSON
          const p = parseJsonObject(draft[key])
          if (p.value) onChange({ ...draft, [key]: formatJson(p.value) })
        }}
      />
      <span className={cn('text-xs', errors[key] ? 'text-destructive' : 'text-muted-foreground')}>{msg(errors[key]) ?? hint}</span>
    </div>
  )

  return (
    <details className="group rounded-md border" open={defaultOpen || undefined} data-testid={`${id}-advanced`}>
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 text-sm font-medium select-none [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-4 transition-transform group-open:rotate-90" />
        {t('settings.advanced.title')}
        {filled && (
          <Badge variant="secondary" className="ml-auto">
            {t('settings.advanced.set')}
          </Badge>
        )}
      </summary>
      <div className="grid gap-3 border-t px-3 pt-3 pb-3">
        <p className="text-xs text-muted-foreground">{t('settings.advanced.hint')}</p>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            title={t('settings.advanced.presetVllmHint')}
            onClick={() =>
              onChange({
                extraBody: formatJson(VLLM_THINKING_PRESET.extra_body),
                extraBodySetReview: formatJson(VLLM_THINKING_PRESET.extra_body_set_review),
                maxTokens: String(VLLM_THINKING_PRESET.max_output_tokens),
                timeoutS: String(VLLM_THINKING_PRESET.timeout_s),
              })
            }
          >
            <Wand2 />
            {t('settings.advanced.presetVllm')}
          </Button>
          {filled && (
            <Button type="button" variant="ghost" size="sm" onClick={() => onChange({ extraBody: '', extraBodySetReview: '', maxTokens: '', timeoutS: '' })}>
              {t('settings.advanced.clear')}
            </Button>
          )}
        </div>
        {field('extraBody', t('settings.advanced.extraBody'), t('settings.advanced.extraBodyHint'), '{"chat_template_kwargs": {"enable_thinking": false}}')}
        {field(
          'extraBodySetReview',
          t('settings.advanced.extraBodySetReview'),
          t('settings.advanced.extraBodySetReviewHint'),
          '{"chat_template_kwargs": {"enable_thinking": true}}',
        )}
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-timeoutS`}>{t('settings.advanced.timeout')}</Label>
          <Input
            id={`${id}-timeoutS`}
            type="number"
            inputMode="numeric"
            min={TIMEOUT_LIMITS.min}
            max={TIMEOUT_LIMITS.max}
            className="w-40"
            placeholder={String(TIMEOUT_DEFAULT_S)}
            value={draft.timeoutS}
            aria-invalid={!!errors.timeoutS}
            onChange={(e) => onChange({ ...draft, timeoutS: e.target.value })}
          />
          <span className={cn('text-xs', errors.timeoutS ? 'text-destructive' : 'text-muted-foreground')}>
            {msg(errors.timeoutS) ?? t('settings.advanced.timeoutHint', { value: TIMEOUT_DEFAULT_S })}
          </span>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-maxTokens`}>{t('settings.advanced.maxTokens')}</Label>
          <Input
            id={`${id}-maxTokens`}
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_OUTPUT_TOKENS_LIMIT}
            className="w-40"
            value={draft.maxTokens}
            aria-invalid={!!errors.maxTokens}
            onChange={(e) => onChange({ ...draft, maxTokens: e.target.value })}
          />
          <span className={cn('text-xs', errors.maxTokens ? 'text-destructive' : 'text-muted-foreground')}>
            {msg(errors.maxTokens) ?? t('settings.advanced.maxTokensHint')}
          </span>
        </div>
      </div>
    </details>
  )
}
