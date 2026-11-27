// Расширенные параметры провайдера: extra_body, extra_body_set_review, max_output_tokens (req_contracts.ProviderConfig).

export type JsonObject = Record<string, unknown>

export interface JsonParse {
  value: JsonObject | null
  /** Код ошибки для перевода: invalid — не JSON, not_object — JSON, но не объект */
  error?: 'invalid' | 'not_object'
  detail?: string
}

/** Пустая строка — null (значение по умолчанию ядра). Иначе только JSON-объект. */
export function parseJsonObject(text: string): JsonParse {
  const s = text.trim()
  if (!s) return { value: null }
  let v: unknown
  try {
    v = JSON.parse(s)
  } catch (e) {
    return { value: null, error: 'invalid', detail: (e as Error).message }
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return { value: null, error: 'not_object' }
  return { value: v as JsonObject }
}

export const formatJson = (v: JsonObject | null | undefined) => (v ? JSON.stringify(v, null, 2) : '')

export const MAX_OUTPUT_TOKENS_LIMIT = 1_000_000

/** Таймаут одного запроса к модели, с: по умолчанию и границы */
export const TIMEOUT_DEFAULT_S = 180
export const TIMEOUT_LIMITS = { min: 10, max: 3600 }

/** vLLM (Qwen3 и др.): без рассуждений на обычных вызовах, с рассуждениями — на поиске противоречий в наборе. */
export const VLLM_THINKING_PRESET = {
  extra_body: { chat_template_kwargs: { enable_thinking: false } },
  extra_body_set_review: { chat_template_kwargs: { enable_thinking: true } },
  max_output_tokens: 48000,
  timeout_s: 900,
} as const
