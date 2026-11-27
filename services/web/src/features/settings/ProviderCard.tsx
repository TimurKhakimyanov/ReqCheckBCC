import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, CircleDot, KeyRound, PlugZap, Save, Server, TriangleAlert } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/api/client'
import type { ProviderSettings, ProviderTestRequest, ProviderTestResult } from '@/api/types'
import { isProviderConfigured } from '@/api/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox, Input, Label } from '@/components/ui/input'
import { Spinner } from '@/components/ui/misc'
import { ModelCombobox } from '@/components/ModelCombobox'
import { ProviderErrorNote } from '@/features/errors/ProviderErrorNote'
import { useModels } from '@/features/runs/LaunchRunDialog'
import { formatDate } from '@/shared/format'
import { AdvancedFields, advancedFrom, advancedToUpdate, type AdvancedDraft } from './AdvancedFields'

export const PROBE_DEBOUNCE_MS = 700

/**
 * Проверка провайдера по ещё не сохранённым полям формы. Запускается сама через PROBE_DEBOUNCE_MS после ввода
 * ключа (или адреса локальной модели) и по кнопке «Проверить». Устаревшие запросы отменяются.
 */
export function useProviderProbe(p: ProviderSettings, apiKey: string, baseUrl: string, extras: ProviderTestRequest = {}) {
  const [result, setResult] = useState<ProviderTestResult | null>(null)
  const [pending, setPending] = useState(false)
  const ctrl = useRef<AbortController | null>(null)
  const compat = p.provider === 'openai_compatible'
  // доп. параметры (extra_body, timeout_s) едут в проверку, но сами её не перезапускают
  const extrasRef = useRef(extras)
  extrasRef.current = extras

  const body = useCallback((): ProviderTestRequest => {
    const b: ProviderTestRequest = { ...extrasRef.current }
    if (apiKey.trim()) b.api_key = apiKey.trim()
    if (compat) b.base_url = baseUrl.trim()
    return b
  }, [apiKey, baseUrl, compat])

  const run = useCallback(
    async (b: ProviderTestRequest) => {
      ctrl.current?.abort()
      const c = new AbortController()
      ctrl.current = c
      setPending(true)
      try {
        const r = await api.testProvider(p.provider, b, c.signal)
        if (!c.signal.aborted) setResult(r)
      } catch (e) {
        if (!c.signal.aborted) setResult({ ok: false, latency_ms: 0, error: (e as Error).message })
      } finally {
        if (ctrl.current === c) setPending(false)
      }
    },
    [p.provider],
  )

  useEffect(() => {
    const keyTyped = apiKey.trim() !== ''
    const urlChanged = compat && baseUrl.trim() !== '' && baseUrl.trim() !== (p.base_url ?? '')
    if (!keyTyped && !urlChanged) return
    if (compat && !baseUrl.trim()) return
    const id = setTimeout(() => void run(body()), PROBE_DEBOUNCE_MS)
    return () => clearTimeout(id)
  }, [apiKey, baseUrl, compat, p.base_url, run, body])

  useEffect(() => () => ctrl.current?.abort(), [])

  return { result, pending, check: () => run(body()) }
}

export function ProviderCard({ p }: { p: ProviderSettings }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const compat = p.provider === 'openai_compatible'
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(p.base_url ?? '')
  const [enabled, setEnabled] = useState(p.enabled)
  const [model, setModel] = useState(p.default_model ?? '')
  const saved = useModels(isProviderConfigured(p) ? p.provider : undefined)
  const [adv, setAdv] = useState<AdvancedDraft>(() => advancedFrom(p))
  const advanced = advancedToUpdate(adv)
  const advInvalid = Object.keys(advanced.errors).length > 0
  const probe = useProviderProbe(
    p,
    apiKey,
    baseUrl,
    advInvalid ? {} : { extra_body: advanced.update.extra_body, timeout_s: advanced.update.timeout_s },
  )

  // живой список из проверки важнее сохранённого; берём его и при ok: false (ключ рабочий, а модель — нет)
  const live = probe.result?.models ?? []
  const options = live.length ? live : (saved.data?.models ?? [])
  const listIsReal = live.length > 0 || (!!saved.data?.models.length && !saved.data.error)
  // модель не подменяем молча: пустую — заполняем первой из списка, отсутствующую — подсвечиваем
  useEffect(() => {
    if (!model.trim() && live.length) setModel(live[0])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [probe.result])
  const backendValid = probe.result ? probe.result.default_model_valid : saved.data?.default_model_valid
  const modelChanged = model.trim() !== (p.default_model ?? '')
  const modelMissing =
    !!model.trim() && ((listIsReal && !options.includes(model.trim())) || (!modelChanged && backendValid === false))
  const warning = probe.result?.warning ?? saved.data?.warning ?? null

  const save = useMutation({
    mutationFn: (body: Parameters<typeof api.updateProvider>[1]) => api.updateProvider(p.provider, body),
    onSuccess: (np) => {
      qc.setQueryData<ProviderSettings[]>(['providers'], (xs) => xs?.map((x) => (x.provider === np.provider ? np : x)))
      void qc.invalidateQueries({ queryKey: ['models', p.provider] })
      setApiKey('')
      toast.success(t('settings.saved'))
    },
    onError: (e) => toast.error(e.message),
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (advInvalid) return
    save.mutate({
      ...advanced.update,
      enabled,
      default_model: model.trim(),
      ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
      ...(compat ? { base_url: baseUrl.trim() } : {}),
    })
  }

  const configured = isProviderConfigured(p)
  const keyTyped = apiKey.trim() !== ''
  const urlTyped = compat && baseUrl.trim() !== (p.base_url ?? '')
  const keyField = (
    <div className="grid gap-1.5">
      <Label htmlFor={`key-${p.provider}`}>{compat ? t('settings.apiKeyOptional') : t('settings.apiKey')}</Label>
      <Input
        id={`key-${p.provider}`}
        type="password"
        autoComplete="off"
        placeholder={p.has_key ? t('settings.keyKeep', { hint: p.key_hint }) : compat ? t('settings.keyOptionalHint') : t('settings.keyEnter')}
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
      />
    </div>
  )

  return (
    <Card className="min-w-0" data-testid={`provider-${p.provider}`}>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>{t(`provider.${p.provider}`)}</CardTitle>
          {keyTyped || urlTyped ? (
            <Badge variant="warning" data-testid="key-state">
              <CircleDot />
              {keyTyped ? t('settings.keyUnsaved') : t('settings.urlUnsaved')}
            </Badge>
          ) : configured ? (
            <Badge variant="success" data-testid="key-state">
              {compat ? <Server /> : <KeyRound />}
              {compat ? t('settings.configured') : t('settings.keySet', { hint: p.key_hint ?? '' })}
            </Badge>
          ) : (
            <Badge variant="secondary" data-testid="key-state">
              {compat ? t('settings.notConfigured') : t('settings.noKey')}
            </Badge>
          )}
        </div>
        <CardDescription>{t(`settings.providerHint.${p.provider}`)}</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-3" onSubmit={submit}>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            {t('settings.enabled')}
          </label>
          {compat && (
            <div className="grid gap-1.5">
              <Label htmlFor={`url-${p.provider}`}>{t('settings.baseUrl')}</Label>
              <Input
                id={`url-${p.provider}`}
                value={baseUrl}
                inputMode="url"
                placeholder="http://vllm.example.local:8000/v1"
                onChange={(e) => setBaseUrl(e.target.value)}
              />
              <span className="text-xs text-muted-foreground">{t('settings.baseUrlHint')}</span>
            </div>
          )}
          {keyField}
          <div className="grid gap-1.5">
            <Label htmlFor={`model-${p.provider}`}>{t('settings.defaultModel')}</Label>
            <ModelCombobox
              id={`model-${p.provider}`}
              value={model}
              onChange={setModel}
              options={options}
              loading={probe.pending || saved.isFetching}
              invalid={modelMissing}
              placeholder={t('settings.modelPlaceholder')}
              aria-describedby={`model-${p.provider}-state`}
            />
            {modelMissing && (
              <span role="alert" className="flex items-start gap-1.5 text-xs text-destructive">
                <TriangleAlert className="mt-px size-3.5 shrink-0" />
                {t('settings.modelUnavailable', { model: model.trim() })}
              </span>
            )}
            {warning && !modelMissing && (
              <span className="flex items-start gap-1.5 text-xs text-warning">
                <TriangleAlert className="mt-px size-3.5 shrink-0" />
                {warning}
              </span>
            )}
            <span id={`model-${p.provider}-state`} className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {probe.pending ? (
                <>
                  <Spinner className="size-3" /> {t('settings.probing')}
                </>
              ) : live.length ? (
                t('settings.modelsLive', { count: live.length })
              ) : saved.data?.error ? (
                t('launch.modelsHint')
              ) : options.length ? (
                t('settings.modelsSaved', { count: options.length })
              ) : (
                t('settings.modelsNone')
              )}
            </span>
          </div>
          <AdvancedFields
            id={`adv-${p.provider}`}
            draft={adv}
            onChange={setAdv}
            defaultOpen={p.extra_body != null || p.extra_body_set_review != null || p.max_output_tokens != null || p.timeout_s != null}
          />
          {probe.result &&
            (probe.result.ok ? (
              <div role="status" className="flex items-center gap-2 rounded-md bg-success/10 px-3 py-2 text-sm text-success">
                <CheckCircle2 className="size-4 shrink-0" />
                {t('settings.testOk', { ms: probe.result.latency_ms })}
              </div>
            ) : (
              <ProviderErrorNote raw={probe.result.error ?? ''} model={model.trim() || undefined} />
            ))}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">
              {p.updated_at ? t('settings.updated', { date: formatDate(p.updated_at) }) : ''}
            </span>
            <div className="flex flex-wrap justify-end gap-2">
              {p.has_key && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => window.confirm(t('settings.confirmRemoveKey')) && save.mutate({ api_key: '' })}
                >
                  {t('settings.removeKey')}
                </Button>
              )}
              <Button type="button" variant="outline" size="sm" onClick={() => void probe.check()} disabled={probe.pending}>
                {probe.pending ? <Spinner /> : <PlugZap />}
                {t('settings.test')}
              </Button>
              <Button type="submit" size="sm" disabled={save.isPending || advInvalid || (compat && !baseUrl.trim())}>
                {save.isPending ? <Spinner /> : <Save />}
                {t('common.save')}
              </Button>
            </div>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}
