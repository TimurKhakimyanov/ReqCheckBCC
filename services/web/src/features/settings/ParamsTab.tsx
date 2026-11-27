import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Cpu, Gauge, KeyRound, Lightbulb, RotateCcw, Save, Sparkles } from 'lucide-react'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api, ApiError } from '@/api/client'
import type { AppSettings, AppSettingsUpdate, EmbeddingsProvider, NumericSetting, ProviderId } from '@/api/types'
import { EMBEDDING_MODELS, EMBEDDINGS_PROVIDERS, isProviderConfigured, SETTING_LIMITS } from '@/api/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input, Label, NativeSelect } from '@/components/ui/input'
import { ErrorNote, Skeleton, Spinner } from '@/components/ui/misc'
import { useAppSettings, useModels, useProviders } from '@/features/runs/LaunchRunDialog'
import { formatDate } from '@/shared/format'

type Draft = Omit<AppSettings, 'embeddings' | 'updated_at'> & {
  embeddings: { provider: EmbeddingsProvider; model: string; api_key: string }
}

const toDraft = (s: AppSettings): Draft => ({
  default_provider: s.default_provider,
  default_model: s.default_model,
  run_timeout_s: s.run_timeout_s,
  request_timeout_s: s.request_timeout_s,
  min_interval_s: s.min_interval_s,
  max_attempts: s.max_attempts,
  batch_size: s.batch_size,
  concurrency: s.concurrency,
  embeddings: { provider: s.embeddings.provider, model: s.embeddings.model, api_key: '' },
})

/** Готовые наборы — «когда что крутить» одной кнопкой. */
export const PRESETS: Record<'free_gemini' | 'paid_api' | 'local', Partial<Record<NumericSetting, number>>> = {
  free_gemini: { min_interval_s: 6, concurrency: 1, max_attempts: 8, batch_size: 6, request_timeout_s: 180 },
  paid_api: { min_interval_s: 0, concurrency: 4, max_attempts: 6, batch_size: 8, request_timeout_s: 180 },
  local: { min_interval_s: 0, concurrency: 1, max_attempts: 4, batch_size: 3, request_timeout_s: 600 },
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
  const changed = value !== lim.default
  return (
    <div className="grid content-start gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={`set-${name}`}>{t(`params.${name}.label`)}</Label>
        {changed && (
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
  const models = useModels(draft?.default_provider ?? undefined)

  const save = useMutation({
    mutationFn: (body: AppSettingsUpdate) => api.updateSettings(body),
    onSuccess: (s) => {
      qc.setQueryData(['settings'], s)
      toast.success(t('settings.saved'))
    },
  })

  if (settings.error) return <ErrorNote error={settings.error} />
  if (!draft || !settings.data) return <Skeleton className="h-96" />

  // ошибки по полям: сначала свои проверки диапазона, затем 422 от сервера
  const fieldErrors: Record<string, string> = {}
  if (save.error instanceof ApiError)
    save.error.errors?.forEach((e) => (fieldErrors[(e.loc ?? []).filter((x) => x !== 'body').join('.')] = e.msg ?? ''))
  Object.assign(fieldErrors, localErrors)

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    setDraft((d) => (d ? { ...d, [k]: v } : d))
    if (localErrors[k as string]) setLocalErrors(({ [k as string]: _drop, ...rest }) => rest)
  }
  const setEmb = (patch: Partial<Draft['embeddings']>) => setDraft((d) => (d ? { ...d, embeddings: { ...d.embeddings, ...patch } } : d))
  const applyPreset = (name: keyof typeof PRESETS) => setDraft((d) => (d ? { ...d, ...PRESETS[name] } : d))

  const embChanged =
    draft.embeddings.provider !== settings.data.embeddings.provider || draft.embeddings.model !== settings.data.embeddings.model

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const errs: Record<string, string> = {}
    for (const [k, lim] of Object.entries(SETTING_LIMITS) as [NumericSetting, (typeof SETTING_LIMITS)[NumericSetting]][]) {
      const v = draft[k]
      if (!Number.isFinite(v) || v < lim.min || v > lim.max) errs[k] = t('params.range', { min: lim.min, max: lim.max })
    }
    setLocalErrors(errs)
    if (Object.keys(errs).length) return
    const { embeddings, ...rest } = draft
    save.mutate({
      ...rest,
      default_model: rest.default_model?.trim() || null,
      embeddings: {
        provider: embeddings.provider,
        model: embeddings.model.trim(),
        ...(embeddings.api_key.trim() ? { api_key: embeddings.api_key.trim() } : {}),
      },
    })
  }

  const num = (k: NumericSetting) => <NumberField key={k} name={k} value={draft[k]} onChange={(v) => set(k, v)} error={fieldErrors[k]} />
  const modelOptions = models.data?.models ?? []

  return (
    <form className="grid gap-4" onSubmit={submit} noValidate data-testid="params-form">
      <Section icon={<Sparkles />} title={t('params.defaults')} description={t('params.defaultsHint')}>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="set-provider">{t('params.defaultProvider')}</Label>
            <NativeSelect
              id="set-provider"
              value={draft.default_provider ?? ''}
              onChange={(e) => {
                const p = (e.target.value || null) as ProviderId | null
                set('default_provider', p)
                set('default_model', providers.data?.find((x) => x.provider === p)?.default_model ?? null)
              }}
            >
              <option value="">{t('params.autoProvider')}</option>
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
            <Input
              id="set-model"
              list="set-model-list"
              value={draft.default_model ?? ''}
              disabled={!draft.default_provider}
              placeholder={t('settings.modelPlaceholder')}
              onChange={(e) => set('default_model', e.target.value)}
              autoComplete="off"
            />
            <datalist id="set-model-list">
              {modelOptions.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
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
          {num('request_timeout_s')}
          {num('run_timeout_s')}
        </div>
      </Section>

      <Section icon={<Cpu />} title={t('params.embeddings')} description={t('params.embeddingsHint')}>
        <div className="grid gap-4 md:grid-cols-3">
          <div className="grid content-start gap-1.5">
            <Label htmlFor="emb-provider">{t('params.embProvider')}</Label>
            <NativeSelect
              id="emb-provider"
              value={draft.embeddings.provider}
              onChange={(e) => {
                const provider = e.target.value as EmbeddingsProvider
                setEmb({ provider, model: EMBEDDING_MODELS[provider][0] })
              }}
            >
              {EMBEDDINGS_PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {t(`params.emb.${p}`)}
                </option>
              ))}
            </NativeSelect>
            <span className="text-xs text-muted-foreground">{t(`params.emb.${draft.embeddings.provider}Hint`)}</span>
          </div>
          <div className="grid content-start gap-1.5">
            <Label htmlFor="emb-model">{t('params.embModel')}</Label>
            <Input
              id="emb-model"
              list="emb-model-list"
              value={draft.embeddings.model}
              onChange={(e) => setEmb({ model: e.target.value })}
              autoComplete="off"
            />
            <datalist id="emb-model-list">
              {EMBEDDING_MODELS[draft.embeddings.provider].map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </div>
          {draft.embeddings.provider !== 'local' && (
            <div className="grid content-start gap-1.5">
              <Label htmlFor="emb-key" className="flex items-center gap-2">
                {t('params.embKey')}
                {settings.data.embeddings.has_key && (
                  <Badge variant="success">
                    <KeyRound />
                    {settings.data.embeddings.key_hint}
                  </Badge>
                )}
              </Label>
              <Input
                id="emb-key"
                type="password"
                autoComplete="off"
                value={draft.embeddings.api_key}
                placeholder={
                  settings.data.embeddings.has_key
                    ? t('settings.keyKeep', { hint: settings.data.embeddings.key_hint })
                    : t('settings.keyEnter')
                }
                onChange={(e) => setEmb({ api_key: e.target.value })}
              />
            </div>
          )}
        </div>
        {embChanged && (
          <p role="note" className="mt-4 rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-sm">
            {t('params.reindexWarning')}
          </p>
        )}
      </Section>

      {save.error && !(save.error instanceof ApiError && save.error.errors?.length) && <ErrorNote error={save.error} />}
      <div className="sticky bottom-0 -mx-1 flex flex-wrap items-center justify-between gap-2 border-t bg-background/95 px-1 py-3 backdrop-blur">
        <span className="text-xs text-muted-foreground">
          {settings.data.updated_at ? t('settings.updated', { date: formatDate(settings.data.updated_at) }) : ''}
        </span>
        <div className="flex gap-2">
          <Button type="button" variant="ghost" onClick={() => setDraft(toDraft(settings.data!))}>
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
