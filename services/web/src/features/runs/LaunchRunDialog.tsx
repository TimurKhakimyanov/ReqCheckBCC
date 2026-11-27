import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Play, TriangleAlert } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router'
import { api } from '@/api/client'
import type { DocumentItem, ProviderId, ValidationOptions } from '@/api/types'
import { DEFAULT_OPTIONS } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Checkbox, Label, NativeSelect } from '@/components/ui/input'
import { ErrorNote, Spinner } from '@/components/ui/misc'

const LAST_KEY = 'reqcheck.lastRun'

function readLast(): { provider?: ProviderId; model?: string; options?: ValidationOptions } {
  try {
    return JSON.parse(localStorage.getItem(LAST_KEY) ?? '{}')
  } catch {
    return {}
  }
}

export function useProviders() {
  return useQuery({ queryKey: ['providers'], queryFn: api.providers })
}

export function useModels(provider?: ProviderId) {
  return useQuery({
    queryKey: ['models', provider],
    queryFn: () => api.models(provider!),
    enabled: !!provider,
    staleTime: 5 * 60_000,
  })
}

export function LaunchRunDialog({
  document,
  open,
  onOpenChange,
}: {
  document: DocumentItem | null
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const providers = useProviders()
  const last = useMemo(readLast, [])

  const usable = (providers.data ?? []).filter((p) => p.enabled)
  const [provider, setProvider] = useState<ProviderId | undefined>(last.provider)
  const [model, setModel] = useState<string>(last.model ?? '')
  const [options, setOptions] = useState<Required<ValidationOptions>>({ ...DEFAULT_OPTIONS, ...last.options })

  // Провайдер по умолчанию: последний использованный, иначе первый с ключом.
  useEffect(() => {
    if (!providers.data) return
    if (provider && usable.some((p) => p.provider === provider)) return
    const pick = usable.find((p) => p.has_key) ?? usable[0]
    setProvider(pick?.provider)
    setModel(pick?.default_model ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers.data])

  const models = useModels(provider)
  const current = usable.find((p) => p.provider === provider)
  const modelList = models.data?.models ?? []
  useEffect(() => {
    if (!modelList.length) return
    if (!model || !modelList.includes(model)) setModel(current?.default_model && modelList.includes(current.default_model) ? current.default_model : modelList[0])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models.data])

  const create = useMutation({
    mutationFn: () => api.createRun({ document_id: document!.id, provider: provider!, model, options }),
    onSuccess: (run) => {
      try {
        localStorage.setItem(LAST_KEY, JSON.stringify({ provider, model, options }))
      } catch {
        /* ignore */
      }
      void qc.invalidateQueries({ queryKey: ['documents'] })
      void qc.invalidateQueries({ queryKey: ['runs'] })
      onOpenChange(false)
      navigate(`/runs/${run.id}`)
    },
  })

  const noKey = current && !current.has_key && current.provider !== 'openai_compatible'
  const opt = (k: keyof ValidationOptions) => (k === 'language' ? null : (
    <label key={k} className="flex cursor-pointer items-start gap-3 rounded-md border p-3 hover:bg-muted/50">
      <Checkbox
        className="mt-0.5"
        checked={options[k] as boolean}
        onChange={(e) => setOptions((o) => ({ ...o, [k]: e.target.checked }))}
      />
      <span className="grid gap-0.5">
        <span className="text-sm font-medium">{t(`launch.opt.${k}`)}</span>
        <span className="text-xs text-muted-foreground">{t(`launch.opt.${k}Hint`)}</span>
      </span>
    </label>
  ))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('launch.title')}</DialogTitle>
          <DialogDescription className="truncate">{document?.name}</DialogDescription>
        </DialogHeader>

        {providers.isPending ? (
          <Spinner />
        ) : usable.length === 0 ? (
          <div className="rounded-md border border-warning/50 bg-warning/10 p-3 text-sm">
            {t('launch.noProviders')}{' '}
            <Link className="font-medium text-primary underline" to="/settings">
              {t('nav.settings')}
            </Link>
          </div>
        ) : (
          <form
            id="launch-form"
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault()
              create.mutate()
            }}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="provider">{t('launch.provider')}</Label>
                <NativeSelect
                  id="provider"
                  value={provider ?? ''}
                  onChange={(e) => {
                    const p = e.target.value as ProviderId
                    setProvider(p)
                    setModel(usable.find((x) => x.provider === p)?.default_model ?? '')
                  }}
                >
                  {usable.map((p) => (
                    <option key={p.provider} value={p.provider}>
                      {t(`provider.${p.provider}`)}
                      {!p.has_key && p.provider !== 'openai_compatible' ? ` — ${t('launch.noKeyShort')}` : ''}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="model">{t('launch.model')}</Label>
                <NativeSelect id="model" value={model} onChange={(e) => setModel(e.target.value)} disabled={models.isPending}>
                  {models.isPending && <option>{t('common.loading')}</option>}
                  {modelList.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                  {model && models.data && !modelList.includes(model) && <option value={model}>{model}</option>}
                </NativeSelect>
                {models.data?.error && (
                  <span className="text-xs text-muted-foreground" title={models.data.error}>
                    {t('launch.modelsHint')}
                  </span>
                )}
              </div>
            </div>
            {noKey && (
              <div className="flex items-start gap-2 rounded-md border border-warning/50 bg-warning/10 p-3 text-sm">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                <span>
                  {t('launch.noKey')}{' '}
                  <Link className="font-medium text-primary underline" to="/settings">
                    {t('nav.settings')}
                  </Link>
                </span>
              </div>
            )}
            <div className="grid gap-2">
              <Label htmlFor="language">{t('launch.reportLanguage')}</Label>
              <NativeSelect
                id="language"
                value={options.language}
                onChange={(e) => setOptions((o) => ({ ...o, language: e.target.value }))}
              >
                <option value="ru">Русский</option>
                <option value="en">English</option>
                <option value="kk">Қазақша</option>
              </NativeSelect>
            </div>
            <div className="grid gap-2">
              {opt('verify_pass')}
              {opt('split_compound')}
              {opt('fill_checklist')}
            </div>
            {create.error && <ErrorNote error={create.error} />}
          </form>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form="launch-form" disabled={!provider || !model || create.isPending || usable.length === 0}>
            {create.isPending ? <Spinner /> : <Play />}
            {t('launch.start')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
