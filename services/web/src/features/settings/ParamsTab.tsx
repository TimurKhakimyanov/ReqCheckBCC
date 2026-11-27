import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Cpu, Gauge, KeyRound, Lightbulb, RotateCcw, Save, SlidersHorizontal, Sparkles } from 'lucide-react'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api, ApiError } from '@/api/client'
import type { AppSettings, AppSettingsUpdate, EmbeddingsProvider, NumericSetting, ProviderId } from '@/api/types'
import {
  DEFAULT_EMBEDDING_MODEL,
  EMBEDDING_MODELS,
  EMBEDDINGS_DIM_LIMITS,
  EMBEDDINGS_PROVIDERS,
  isProviderConfigured,
  SETTING_LIMITS,
} from '@/api/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input, Label, NativeSelect } from '@/components/ui/input'
import { ErrorNote, Skeleton, Spinner } from '@/components/ui/misc'
import { ModelCombobox } from '@/components/ModelCombobox'
import { useAppSettings, useModels, useProviders } from '@/features/runs/LaunchRunDialog'
import { formatDate } from '@/shared/format'

/** Редактируемая копия настроек; строки — как в полях ввода. */
interface Draft extends Record<NumericSetting, number> {
  default_provider: ProviderId
  default_model: string
  embeddings_provider: EmbeddingsProvider
  embeddings_model: string
  embeddings_dim: string
  embeddings_api_key: string
}

const toDraft = (s: AppSettings): Draft => ({
  default_provider: s.default_provider,
  default_model: s.default_model ?? '',
  run_timeout_s: s.run_timeout_s,
  min_interval_s: s.min_interval_s,
  max_attempts: s.max_attempts,
  batch_size: s.batch_size,
  concurrency: s.concurrency,
  max_upload_mb: s.max_upload_mb,
  session_ttl_hours: s.session_ttl_hours,
  embeddings_provider: s.embeddings_provider,
  embeddings_model: s.embeddings_model ?? '',
  embeddings_dim: s.embeddings_dim == null ? '' : String(s.embeddings_dim),
  embeddings_api_key: '',
})

/** Готовые наборы — «когда что крутить» одной кнопкой. */
export const PRESETS: Record<'free_gemini' | 'paid_api' | 'local', Partial<Record<NumericSetting, number>>> = {
  free_gemini: { min_interval_s: 6, concurrency: 1, max_attempts: 8, batch_size: 6 },
  paid_api: { min_interval_s: 0, concurrency: 4, max_attempts: 6, batch_size: 8 },
  local: { min_interval_s: 0, concurrency: 1, max_attempts: 4, batch_size: 3, run_timeout_s: 3600 },
}

function NumberField({
  name,
  value,
  onChange,
  error,
}: {
  name: NumericSetting
  value: number
  onChange: (v: number) => void
  error?: string
}) {
  const { t } = useTranslation()
  const lim = SETTING_LIMITS[name]
  return (
    <div className="grid content-start gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={`set-${name}`}>{t(`params.${name}.label`)}</Label>
        {value !== lim.default && (
          <button
            type="button"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => onChange(lim.default)}
            title={t('params.resetTo', { value: lim.default })}
          >
            <RotateCcw className="size-3" />
            {lim.default}
          </button>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Input
          id={`set-${name}`}
          type="number"
          inputMode="decimal"
          min={lim.min}
          max={lim.max}
          step={lim.step}
          value={Number.isFinite(value) ? value : ''}
          aria-invalid={!!error}
          onChange={(e) => onChange(e.target.value === '' ? NaN : Number(e.target.value))}
          className="w-32"
        />
        <span className="text-sm text-muted-foreground">{t(`params.${name}.unit`)}</span>
      </div>
      {error ? (
        <span className="text-xs text-destructive">{error}</span>
      ) : (
        <p className="flex gap-1.5 text-xs leading-relaxed text-muted-foreground">
          <Lightbulb className="mt-0.5 size-3.5 shrink-0 text-warning" />
          <span>{t(`params.${name}.hint`)}</span>
        </p>
      )}
    </div>
  )
}

function Section({ icon, title, description, children }: { icon: ReactNode; title: string; description?: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base [&_svg]:size-4">
          {icon}
          {title}
        </CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

export function ParamsTab() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const settings = useAppSettings()
  const providers = useProviders()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [localErrors, setLocalErrors] = useState<Record<string, string>>({})
  useEffect(() => {
    if (settings.data) setDraft(toDraft(settings.data))
  }, [settings.data])
  const models = useModels(draft?.default_provider)

  const save = useMutation({
    mutationFn: (body: AppSettingsUpdate) => api.updateSettings(body),
    onSuccess: (s) => {
      qc.setQueryData(['settings'], s)
      void qc.invalidateQueries({ queryKey: ['health'] })
      toast.success(t('settings.saved'))
    },
  })

  if (settings.error) return <ErrorNote error={settings.error} />
  if (!draft || !settings.data) return <Skeleton className="h-96" />
  const saved = settings.data

  // ошибки по полям: свои проверки диапазона, затем 422 от сервера
  const fieldErrors: Record<string, string> = {}
  if (save.error instanceof ApiError)
    save.error.errors?.forEach((e) => (fieldErrors[(e.loc ?? []).filter((x) => x !== 'body').join('.')] = e.msg ?? ''))
  Object.assign(fieldErrors, localErrors)

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    setDraft((d) => (d ? { ...d, [k]: v } : d))
    if (localErrors[k]) setLocalErrors(({ [k]: _drop, ...rest }) => rest)
  }
  const applyPreset = (name: keyof typeof PRESETS) => setDraft((d) => (d ? { ...d, ...PRESETS[name] } : d))

  const embChanged =
    draft.embeddings_provider !== saved.embeddings_provider ||
    draft.embeddings_model.trim() !== (saved.embeddings_model ?? '') ||
    draft.embeddings_dim.trim() !== (saved.embeddings_dim == null ? '' : String(saved.embeddings_dim))

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const errs: Record<string, string> = {}
    for (const [k, lim] of Object.entries(SETTING_LIMITS) as [NumericSetting, (typeof SETTING_LIMITS)[NumericSetting]][]) {
      const v = draft[k]
      if (!Number.isFinite(v) || v < lim.min || v > lim.max) errs[k] = t('params.range', { min: lim.min, max: lim.max })
    }
    const dim = draft.embeddings_dim.trim() === '' ? null : Number(draft.embeddings_dim)
    if (dim !== null && (!Number.isInteger(dim) || dim < EMBEDDINGS_DIM_LIMITS.min || dim > EMBEDDINGS_DIM_LIMITS.max))
      errs.embeddings_dim = t('params.range', { min: EMBEDDINGS_DIM_LIMITS.min, max: EMBEDDINGS_DIM_LIMITS.max })
    setLocalErrors(errs)
    if (Object.keys(errs).length) return
    const { embeddings_api_key, embeddings_dim: _dimText, ...rest } = draft
    save.mutate({
      ...rest,
      default_model: rest.default_model.trim() || null,
      embeddings_model: rest.embeddings_model.trim() || null,
      embeddings_dim: draft.embeddings_provider === 'gemini' ? dim : null,
      ...(embeddings_api_key.trim() ? { embeddings_api_key: embeddings_api_key.trim() } : {}),
    })
  }

  const num = (k: NumericSetting) => <NumberField key={k} name={k} value={draft[k]} onChange={(v) => set(k, v)} error={fieldErrors[k]} />
  const defaultEmbModel = DEFAULT_EMBEDDING_MODEL[draft.embeddings_provider]

  return (
    <form className="grid gap-4" onSubmit={submit} noValidate data-testid="params-form">
      <Section icon={<Sparkles />} title={t('params.defaults')} description={t('params.defaultsHint')}>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="set-provider">{t('params.defaultProvider')}</Label>
            <NativeSelect
              id="set-provider"
              value={draft.default_provider}
              onChange={(e) => {
                const p = e.target.value as ProviderId
                set('default_provider', p)
                set('default_model', providers.data?.find((x) => x.provider === p)?.default_model ?? '')
              }}
            >
              {providers.data?.map((p) => (
                <option key={p.provider} value={p.provider}>
                  {t(`provider.${p.provider}`)}
                  {!isProviderConfigured(p) ? ` — ${t('settings.notConfigured').toLowerCase()}` : ''}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="set-model">{t('params.defaultModel')}</Label>
            <ModelCombobox
              id="set-model"
              value={draft.default_model}
              onChange={(v) => set('default_model', v)}
              options={models.data?.models ?? []}
              loading={models.isFetching}
              placeholder={t('settings.modelPlaceholder')}
            />
          </div>
        </div>
      </Section>

      <Section icon={<Gauge />} title={t('params.pacing')} description={t('params.pacingHint')}>
        <div className="mb-5 flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">{t('params.presets')}:</span>
          {(Object.keys(PRESETS) as (keyof typeof PRESETS)[]).map((name) => (
            <Button key={name} type="button" variant="outline" size="sm" onClick={() => applyPreset(name)} title={t(`params.preset.${name}Hint`)}>
              {t(`params.preset.${name}`)}
            </Button>
          ))}
        </div>
        <div className="grid gap-x-6 gap-y-5 md:grid-cols-2 xl:grid-cols-3">
          {num('min_interval_s')}
          {num('concurrency')}
          {num('max_attempts')}
          {num('batch_size')}
          {num('run_timeout_s')}
        </div>
      </Section>

      <Section icon={<Cpu />} title={t('params.embeddings')} description={t('params.embeddingsHint')}>
        <div className="grid gap-4 md:grid-cols-3">
          <div className="grid content-start gap-1.5">
            <Label htmlFor="emb-provider">{t('params.embProvider')}</Label>
            <NativeSelect
              id="emb-provider"
              value={draft.embeddings_provider}
              onChange={(e) => {
                set('embeddings_provider', e.target.value as EmbeddingsProvider)
                set('embeddings_model', '')
              }}
            >
              {EMBEDDINGS_PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {t(`params.emb.${p}`)}
                </option>
              ))}
            </NativeSelect>
            <span className="text-xs text-muted-foreground">{t(`params.emb.${draft.embeddings_provider}Hint`)}</span>
          </div>
          <div className="grid content-start gap-1.5">
            <Label htmlFor="emb-model">{t('params.embModel')}</Label>
            <Input
              id="emb-model"
              list="emb-model-list"
              value={draft.embeddings_model}
              placeholder={defaultEmbModel ?? ''}
              onChange={(e) => set('embeddings_model', e.target.value)}
              autoComplete="off"
            />
            <datalist id="emb-model-list">
              {EMBEDDING_MODELS[draft.embeddings_provider].map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            <span className="text-xs text-muted-foreground">
              {defaultEmbModel ? t('params.embModelDefault', { model: defaultEmbModel }) : t('params.embModelBuiltin')}
            </span>
          </div>
          {draft.embeddings_provider !== 'local' && (
            <div className="grid content-start gap-1.5">
              <Label htmlFor="emb-key" className="flex items-center gap-2">
                {t('params.embKey')}
                {saved.embeddings_has_key && (
                  <Badge variant="success">
                    <KeyRound />
                    {saved.embeddings_key_hint}
                  </Badge>
                )}
              </Label>
              <Input
                id="emb-key"
                type="password"
                autoComplete="off"
                value={draft.embeddings_api_key}
                placeholder={saved.embeddings_has_key ? t('settings.keyKeep', { hint: saved.embeddings_key_hint }) : t('settings.keyEnter')}
                onChange={(e) => set('embeddings_api_key', e.target.value)}
              />
            </div>
          )}
          {draft.embeddings_provider === 'gemini' && (
            <div className="grid content-start gap-1.5">
              <Label htmlFor="emb-dim">{t('params.embDim')}</Label>
              <Input
                id="emb-dim"
                type="number"
                className="w-32"
                min={EMBEDDINGS_DIM_LIMITS.min}
                max={EMBEDDINGS_DIM_LIMITS.max}
                placeholder={String(EMBEDDINGS_DIM_LIMITS.default)}
                value={draft.embeddings_dim}
                aria-invalid={!!fieldErrors.embeddings_dim}
                onChange={(e) => set('embeddings_dim', e.target.value)}
              />
              <span className={fieldErrors.embeddings_dim ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
                {fieldErrors.embeddings_dim || t('params.embDimHint')}
              </span>
            </div>
          )}
        </div>
        {embChanged && (
          <p role="note" className="mt-4 rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-sm">
            {t('params.reindexWarning')}
          </p>
        )}
      </Section>

      <Section icon={<SlidersHorizontal />} title={t('params.other')}>
        <div className="grid gap-x-6 gap-y-5 md:grid-cols-2 xl:grid-cols-3">
          {num('max_upload_mb')}
          {num('session_ttl_hours')}
        </div>
      </Section>

      {save.error && !(save.error instanceof ApiError && save.error.errors?.length) && <ErrorNote error={save.error} />}
      <div className="sticky bottom-0 -mx-1 flex flex-wrap items-center justify-between gap-2 border-t bg-background/95 px-1 py-3 backdrop-blur">
        <span className="text-xs text-muted-foreground">
          {saved.updated_at ? t('settings.updated', { date: formatDate(saved.updated_at) }) : ''}
        </span>
        <div className="flex gap-2">
          <Button type="button" variant="ghost" onClick={() => setDraft(toDraft(saved))}>
            {t('params.revert')}
          </Button>
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? <Spinner /> : <Save />}
            {t('common.save')}
          </Button>
        </div>
      </div>
    </form>
  )
}
