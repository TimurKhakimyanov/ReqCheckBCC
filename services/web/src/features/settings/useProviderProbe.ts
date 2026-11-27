import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/api/client'
import type { ProviderSettings, ProviderTestRequest, ProviderTestResult } from '@/api/types'

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
