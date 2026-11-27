// Перевод сырых ошибок провайдеров LLM («BadRequestError: Error code: 400 - {...}») в короткий понятный текст.
// Сырой текст не теряется — он показывается в «Подробностях».

export type ProviderErrorKind =
  | 'auth'
  | 'forbidden'
  | 'rate_limit'
  | 'quota'
  | 'not_found'
  | 'bad_request'
  | 'context'
  | 'timeout'
  | 'connection'
  | 'unavailable'
  | 'invalid_output'
  | 'not_configured'
  | 'not_implemented'
  | 'cancelled'
  | 'unknown'

export const PROVIDER_ERROR_KINDS: ProviderErrorKind[] = [
  'auth',
  'forbidden',
  'rate_limit',
  'quota',
  'not_found',
  'bad_request',
  'context',
  'timeout',
  'connection',
  'unavailable',
  'invalid_output',
  'not_configured',
  'not_implemented',
  'cancelled',
  'unknown',
]

export interface ProviderErrorInfo {
  kind: ProviderErrorKind
  /** HTTP-код из текста ошибки, если удалось найти */
  status?: number
  /** Сообщение самого провайдера (error.message), если удалось вытащить */
  providerMessage?: string
  raw: string
}

const RULES: [ProviderErrorKind, RegExp][] = [
  ['cancelled', /\bcancel(l)?ed\b|отмен[её]н/i],
  ['not_implemented', /NotImplementedError|не реализовано/i],
  ['not_configured', /provider_not_configured|API[- ]?ключ не задан|не задан адрес|no api key|api key is not set/i],
  ['context', /context[_ ]length|maximum context|too many tokens|context window|token limit|prompt is too long/i],
  ['quota', /insufficient_quota|quota|billing|RESOURCE_EXHAUSTED.*(?:quota|per day)|exceeded your current/i],
  ['rate_limit', /\b429\b|RateLimit|rate[_ ]limit|RESOURCE_EXHAUSTED|too many requests/i],
  ['auth', /\b401\b|Authentication|Unauthorized|invalid[_ ]api[_ ]key|Incorrect API key|API key not valid|отклонил ключ/i],
  ['forbidden', /\b403\b|PermissionDenied|Forbidden|permission/i],
  ['timeout', /timed? ?out|Timeout|ReadTimeout|deadline exceeded|превышено время|таймаут/i],
  ['connection', /APIConnectionError|ConnectError|Connection (?:error|refused|reset)|Name or service not known|getaddrinfo|ECONNREFUSED|Failed to establish|Нет соединения|NetworkError|Failed to fetch/i],
  ['unavailable', /\b5\d\d\b|ServiceUnavailable|InternalServerError|overloaded|Bad Gateway|unavailable/i],
  ['not_found', /\b404\b|NotFound|model_not_found|does not exist|not found/i],
  ['invalid_output', /JSON|ValidationError|parse|невалидн/i],
  ['bad_request', /\b400\b|BadRequest|invalid_request|unsupported/i],
]

/** Вытаскивает error.message из «Error code: 400 - {'error': {'message': '...'}}» (dict Python или JSON). */
export function extractProviderMessage(raw: string): string | undefined {
  const m =
    /['"]message['"]\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw) ?? /['"]message['"]\s*:\s*'((?:[^'\\]|\\.)*)'/.exec(raw)
  return m ? m[1].replace(/\\(["'\\])/g, '$1').trim() : undefined
}

/** Имя модели из текста 404: «model: x», «The model `x` does not exist», «models/x is not found». */
export function extractModelName(raw: string): string | undefined {
  const m =
    /model[`'"]?\s*[:=]\s*[`'"]?([\w.:/@-]+)/i.exec(raw) ??
    /model\s+[`'"]([^`'"]+)[`'"]/i.exec(raw) ??
    /models\/([\w.:@-]+)/i.exec(raw)
  return m?.[1]
}

export function describeProviderError(raw: string | null | undefined): ProviderErrorInfo {
  const text = (raw ?? '').trim()
  const statusMatch = /(?:Error code|status(?: code)?|HTTP)\s*[:=]?\s*(\d{3})\b/i.exec(text) ?? /\b([45]\d\d)\b/.exec(text)
  const status = statusMatch ? Number(statusMatch[1]) : undefined
  const kind = RULES.find(([, re]) => re.test(text))?.[0] ?? 'unknown'
  return { kind, status, providerMessage: extractProviderMessage(text), raw: text }
}
