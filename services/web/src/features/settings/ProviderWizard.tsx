import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ArrowRight, Check, CheckCircle2, PlugZap, Save, TriangleAlert } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/api/client'
import type { ProviderId, ProviderSettings } from '@/api/types'
import { isProviderConfigured, PROVIDERS } from '@/api/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Checkbox, Input, Label } from '@/components/ui/input'
import { Spinner } from '@/components/ui/misc'
import { ModelCombobox } from '@/components/ModelCombobox'
import { ProviderErrorNote } from '@/features/errors/ProviderErrorNote'
import { useModels } from '@/features/runs/LaunchRunDialog'
import { cn } from '@/shared/utils'
import { AdvancedFields, advancedFrom, advancedToUpdate, type AdvancedDraft } from './AdvancedFields'
import { useProviderProbe } from './useProviderProbe'

export const WIZARD_STEPS = ['provider', 'account', 'model', 'params', 'review'] as const
type Step = (typeof WIZARD_STEPS)[number]

// ---------------------------------------------------------------- значок провайдера

const MONO: Record<ProviderId, { letter: string; cls: string }> = {
  gemini: { letter: 'G', cls: 'bg-primary-tint text-primary' },
  openai: { letter: 'O', cls: 'bg-success/15 text-success' },
  anthropic: { letter: 'A', cls: 'bg-sev-major-bg text-sev-major' },
  openai_compatible: { letter: '⌂', cls: 'bg-secondary text-foreground' },
}

export function ProviderMark({ id, className }: { id: ProviderId; className?: string }) {
  const m = MONO[id]
  return (
    <span aria-hidden className={cn('inline-flex size-9 shrink-0 items-center justify-center rounded-xl text-base font-semibold', m.cls, className)}>
      {m.letter}
    </span>
  )
}

// ---------------------------------------------------------------- шаги

export function Stepper({ current }: { current: number }) {
  const { t } = useTranslation()
  const pct = (current / (WIZARD_STEPS.length - 1)) * 100
  return (
    <ol className="relative grid grid-cols-5" aria-label={t('wizard.progress', { step: current + 1, total: WIZARD_STEPS.length })}>
      <span aria-hidden className="absolute top-3.5 right-[10%] left-[10%] h-0.5 rounded-full bg-muted" />
      <span
        aria-hidden
        className="absolute top-3.5 left-[10%] h-0.5 rounded-full bg-primary transition-[width] duration-500 ease-out"
        style={{ width: `${pct * 0.8}%` }}
      />
      {WIZARD_STEPS.map((s, i) => {
        const done = i < current
        const active = i === current
        return (
          <li key={s} className="relative flex flex-col items-center gap-1.5" aria-current={active ? 'step' : undefined}>
            <span
              className={cn(
                'relative z-10 flex size-7 items-center justify-center rounded-full border-2 text-xs font-semibold transition-all duration-300',
                done && 'border-primary bg-primary text-primary-foreground',
                active && 'scale-110 border-primary bg-card text-primary shadow-[0_0_0_4px_var(--primary-tint)]',
                !done && !active && 'border-border bg-card text-muted-foreground',
              )}
            >
              {done ? <Check className="size-3.5" /> : i + 1}
            </span>
            <span className={cn('text-center text-[11px] leading-tight', active ? 'font-medium text-foreground' : 'text-muted-foreground')}>
              {t(`wizard.steps.${s}`)}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

function StepTitle({ title, hint }: { title: string; hint?: ReactNode }) {
  return (
    <div className="grid gap-1">
      <h3 className="font-medium">{title}</h3>
      {hint && <p className="text-sm text-muted-foreground">{hint}</p>}
    </div>
  )
}

function ChooseProvider({ providers, onPick }: { providers: ProviderSettings[]; onPick: (id: ProviderId) => void }) {
  const { t } = useTranslation()
  return (
    <div className="rc-fade grid gap-3">
      <StepTitle title={t('wizard.chooseTitle')} hint={t('wizard.chooseHint')} />
      <div className="grid gap-2 sm:grid-cols-2">
        {PROVIDERS.map((id, i) => {
          const p = providers.find((x) => x.provider === id)
          const connected = p ? isProviderConfigured(p) : false
          return (
            <button
              key={id}
              type="button"
              onClick={() => onPick(id)}
              data-testid={`pick-${id}`}
              className="group flex items-start gap-3 rounded-xl border bg-card p-3 text-left transition-all hover:-translate-y-0.5 hover:border-primary hover:shadow-card focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              style={{ animation: `rc-fade 0.5s ease ${i * 60}ms both` }}
            >
              <ProviderMark id={id} className="transition-transform group-hover:scale-110" />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-sm font-medium">
                  {t(`provider.${id}`)}
                  {connected && (
                    <Badge variant="success" className="px-1.5 py-0">
                      {t('wizard.connected')}
                    </Badge>
                  )}
                </span>
                <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">{t(`settings.providerHint.${id}`)}</span>
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function ProbeStatus({ pending, result, model }: { pending: boolean; result: ReturnType<typeof useProviderProbe>['result']; model?: string }) {
  const { t } = useTranslation()
  if (pending)
    return (
      <div role="status" className="flex items-center gap-2 rounded-xl bg-secondary px-3 py-2 text-sm text-muted-foreground">
        <Spinner className="size-3.5" /> {t('settings.probing')}
      </div>
    )
  if (!result) return null
  return result.ok ? (
    <div role="status" className="rc-fade flex items-center gap-2 rounded-xl bg-success/10 px-3 py-2 text-sm text-success">
      <CheckCircle2 className="size-4 shrink-0" />
      {t('settings.testOk', { ms: result.latency_ms })}
    </div>
  ) : (
    <ProviderErrorNote raw={result.error ?? ''} model={model} />
  )
}

/** Шаги 2–5 для выбранного провайдера. Состояние формы живёт здесь; при смене провайдера компонент пересоздаётся. */
function WizardForm({
  p,
  step,
  setStep,
  onBack,
  onDone,
}: {
  p: ProviderSettings
  step: Exclude<Step, 'provider'>
  setStep: (s: Step) => void
  onBack: () => void
  onDone: () => void
}) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const compat = p.provider === 'openai_compatible'
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(p.base_url ?? '')
  const [enabled, setEnabled] = useState(isProviderConfigured(p) ? p.enabled : true)
  const [model, setModel] = useState(p.default_model ?? '')
  const [adv, setAdv] = useState<AdvancedDraft>(() => advancedFrom(p))
  const advanced = advancedToUpdate(adv)
  const advInvalid = Object.keys(advanced.errors).length > 0
  const saved = useModels(isProviderConfigured(p) ? p.provider : undefined)
  const probe = useProviderProbe(
    p,
    apiKey,
    baseUrl,
    advInvalid ? {} : { extra_body: advanced.update.extra_body, timeout_s: advanced.update.timeout_s },
  )

  const live = probe.result?.models ?? []
  const options = live.length ? live : (saved.data?.models ?? [])
  const listIsReal = live.length > 0 || (!!saved.data?.models.length && !saved.data.error)
  useEffect(() => {
    if (!model.trim() && live.length) setModel(probe.result?.model && live.includes(probe.result.model) ? probe.result.model : live[0])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [probe.result])
  const modelMissing = !!model.trim() && listIsReal && !options.includes(model.trim())
  const warning = probe.result?.warning ?? saved.data?.warning ?? null

  const accountReady = compat ? !!baseUrl.trim() : p.has_key || !!apiKey.trim()

  const save = useMutation({
    mutationFn: () =>
      api.updateProvider(p.provider, {
        ...advanced.update,
        enabled,
        default_model: model.trim(),
        ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
        ...(compat ? { base_url: baseUrl.trim() } : {}),
      }),
    onSuccess: (np) => {
      qc.setQueryData<ProviderSettings[]>(['providers'], (xs) => xs?.map((x) => (x.provider === np.provider ? np : x)))
      void qc.invalidateQueries({ queryKey: ['models', p.provider] })
      toast.success(t('wizard.saved', { name: t(`provider.${p.provider}`) }))
      onDone()
    },
    onError: (e) => toast.error(e.message),
  })

  const idx = WIZARD_STEPS.indexOf(step)
  const prev = () => (idx <= 1 ? onBack() : setStep(WIZARD_STEPS[idx - 1]))
  const next = () => setStep(WIZARD_STEPS[idx + 1])
  const canNext = step === 'account' ? accountReady : step === 'model' ? !!model.trim() : step === 'params' ? !advInvalid : true

  const credential = compat
    ? baseUrl.trim()
    : apiKey.trim()
      ? t('wizard.newKey', { hint: `…${apiKey.trim().slice(-4)}` })
      : p.has_key
        ? t('wizard.keptKey', { hint: p.key_hint ?? '' })
        : '—'

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        if (step === 'review') save.mutate()
        else if (canNext) next()
      }}
    >
      <div key={step} className="rc-fade grid min-h-56 content-start gap-3">
        {step === 'account' && (
          <>
            <StepTitle
              title={compat ? t('wizard.accountTitleLocal') : t('wizard.accountTitle', { name: t(`provider.${p.provider}`) })}
              hint={t(`settings.providerHint.${p.provider}`)}
            />
            {compat && (
              <div className="grid gap-1.5">
                <Label htmlFor="wz-url">{t('settings.baseUrl')}</Label>
                <Input
                  id="wz-url"
                  autoFocus
                  value={baseUrl}
                  inputMode="url"
                  placeholder="http://vllm.example.local:8000/v1"
                  onChange={(e) => setBaseUrl(e.target.value)}
                />
                <span className="text-xs text-muted-foreground">{t('settings.baseUrlHint')}</span>
              </div>
            )}
            <div className="grid gap-1.5">
              <Label htmlFor="wz-key">{compat ? t('settings.apiKeyOptional') : t('settings.apiKey')}</Label>
              <Input
                id="wz-key"
                type="password"
                autoComplete="off"
                autoFocus={!compat}
                placeholder={p.has_key ? t('settings.keyKeep', { hint: p.key_hint }) : compat ? t('settings.keyOptionalHint') : t('settings.keyEnter')}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
              <span className="text-xs text-muted-foreground">{t('wizard.keySafe')}</span>
            </div>
            <ProbeStatus pending={probe.pending} result={probe.result} model={model.trim() || undefined} />
          </>
        )}
        {step === 'model' && (
          <>
            <StepTitle title={t('wizard.modelTitle')} hint={t('wizard.modelHint')} />
            <div className="grid gap-1.5">
              <Label htmlFor="wz-model">{t('settings.defaultModel')}</Label>
              <ModelCombobox
                id="wz-model"
                value={model}
                onChange={setModel}
                options={options}
                loading={probe.pending || saved.isFetching}
                invalid={modelMissing}
                placeholder={t('settings.modelPlaceholder')}
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
              <span className="text-xs text-muted-foreground">
                {live.length
                  ? t('settings.modelsLive', { count: live.length })
                  : options.length
                    ? t('settings.modelsSaved', { count: options.length })
                    : t('settings.modelsNone')}
              </span>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
              {t('settings.enabled')}
            </label>
          </>
        )}
        {step === 'params' && (
          <>
            <StepTitle title={t('wizard.paramsTitle')} hint={t('wizard.paramsHint')} />
            <AdvancedFields id={`wz-adv-${p.provider}`} draft={adv} onChange={setAdv} defaultOpen />
          </>
        )}
        {step === 'review' && (
          <>
            <StepTitle title={t('wizard.reviewTitle')} hint={t('wizard.reviewHint')} />
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 rounded-xl bg-secondary/60 p-4 text-sm">
              <dt className="text-muted-foreground">{t('wizard.steps.provider')}</dt>
              <dd className="flex items-center gap-2 font-medium">
                <ProviderMark id={p.provider} className="size-6 rounded-lg text-xs" />
                {t(`provider.${p.provider}`)}
              </dd>
              <dt className="text-muted-foreground">{compat ? t('settings.baseUrl') : t('settings.apiKey')}</dt>
              <dd className="truncate font-mono text-xs leading-5">{credential}</dd>
              <dt className="text-muted-foreground">{t('settings.defaultModel')}</dt>
              <dd className="truncate font-mono text-xs leading-5">{model.trim() || '—'}</dd>
              <dt className="text-muted-foreground">{t('wizard.state')}</dt>
              <dd>{enabled ? t('wizard.on') : t('wizard.off')}</dd>
              <dt className="text-muted-foreground">{t('wizard.steps.params')}</dt>
              <dd>
                {adv.extraBody.trim() || adv.extraBodySetReview.trim() || adv.maxTokens.trim() || adv.timeoutS.trim()
                  ? t('settings.advanced.set')
                  : t('wizard.defaults')}
              </dd>
            </dl>
            <ProbeStatus pending={probe.pending} result={probe.result} model={model.trim() || undefined} />
          </>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-4">
        <Button type="button" variant="ghost" size="sm" onClick={prev}>
          <ArrowLeft />
          {t('common.back')}
        </Button>
        <div className="flex flex-wrap gap-2">
          {(step === 'account' || step === 'review') && (
            <Button type="button" variant="outline" size="sm" onClick={() => void probe.check()} disabled={probe.pending || !accountReady}>
              {probe.pending ? <Spinner /> : <PlugZap />}
              {t('settings.test')}
            </Button>
          )}
          {step === 'params' && (
            <Button type="button" variant="ghost" size="sm" onClick={next}>
              {t('wizard.skip')}
            </Button>
          )}
          {step === 'review' ? (
            <Button type="submit" size="sm" disabled={save.isPending || advInvalid || !accountReady}>
              {save.isPending ? <Spinner /> : <Save />}
              {t('wizard.finish')}
            </Button>
          ) : (
            <Button type="submit" size="sm" disabled={!canNext}>
              {t('wizard.next')}
              <ArrowRight />
            </Button>
          )}
        </div>
      </div>
    </form>
  )
}

/** Пошаговое добавление (и изменение) провайдера: выбор → учётная запись → модель → параметры → проверка. */
export function ProviderWizard({
  open,
  onOpenChange,
  providers,
  initial,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  providers: ProviderSettings[]
  /** Изменить этого провайдера: мастер начинается со второго шага */
  initial?: ProviderId | null
}) {
  const { t } = useTranslation()
  const [pid, setPid] = useState<ProviderId | null>(initial ?? null)
  const [step, setStep] = useState<Step>(initial ? 'account' : 'provider')
  useEffect(() => {
    if (open) {
      setPid(initial ?? null)
      setStep(initial ? 'account' : 'provider')
    }
  }, [open, initial])
  const p = pid ? providers.find((x) => x.provider === pid) : undefined
  const editing = !!p && isProviderConfigured(p)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl gap-5">
        <DialogHeader>
          <DialogTitle>{editing ? t('wizard.editTitle', { name: t(`provider.${p.provider}`) }) : t('wizard.title')}</DialogTitle>
          <DialogDescription>{t('wizard.subtitle')}</DialogDescription>
        </DialogHeader>
        <Stepper current={WIZARD_STEPS.indexOf(step)} />
        {step === 'provider' || !p ? (
          <ChooseProvider
            providers={providers}
            onPick={(id) => {
              setPid(id)
              setStep('account')
            }}
          />
        ) : (
          <WizardForm
            key={p.provider}
            p={p}
            step={step}
            setStep={setStep}
            onBack={() => setStep('provider')}
            onDone={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
