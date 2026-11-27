// Тонкий клиент HTTP API (docs/api.md). Все запросы идут на тот же origin: /api/* проксирует nginx.
import { readSSE } from './sse'
import type {
  AuditEntry,
  ChatMessage,
  DocumentItem,
  ExportFormat,
  FindingReview,
  FindingWithReview,
  Health,
  KnowledgeItem,
  ModelsResponse,
  Page,
  ProviderId,
  ProviderSettings,
  ProviderTestRequest,
  ProviderTestResult,
  ProviderUpdate,
  Report,
  ReviewStatus,
  Run,
  RunCreate,
  SearchHit,
  UsageResponse,
  User,
} from './types'

export const API_BASE = '/api'

export interface FieldError {
  loc?: (string | number)[]
  msg?: string
  type?: string
}

export class ApiError extends Error {
  status: number
  code?: string
  /** 422: ошибки валидации по полям (формат FastAPI) */
  errors?: FieldError[]
  constructor(status: number, message: string, code?: string, errors?: FieldError[]) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.errors = errors
  }
}

let unauthorizedHandler: (() => void) | null = null
/** Вызывается при 401 на любом запросе, кроме логина: приложение сбрасывает сессию и ведёт на /login. */
export function onUnauthorized(fn: (() => void) | null) {
  unauthorizedHandler = fn
}

export async function toError(res: Response): Promise<ApiError> {
  let message = `${res.status} ${res.statusText}`
  let code: string | undefined
  let errors: FieldError[] | undefined
  try {
    const body = await res.json()
    if (typeof body?.detail === 'string') message = body.detail
    else if (Array.isArray(body?.detail)) message = body.detail.map((d: FieldError) => d.msg).join('; ')
    code = body?.code
    if (Array.isArray(body?.errors)) errors = body.errors
  } catch {
    /* тело не JSON */
  }
  return new ApiError(res.status, message, code, errors)
}

export async function request<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'same-origin',
    ...rest,
    headers: {
      Accept: 'application/json',
      ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  })
  if (res.status === 401 && !path.startsWith('/auth/login')) unauthorizedHandler?.()
  if (!res.ok) throw await toError(res)
  if (res.status === 204 || res.headers.get('content-length') === '0') return undefined as T
  const ct = res.headers.get('content-type') ?? ''
  return (ct.includes('application/json') ? res.json() : res.text()) as Promise<T>
}

const qs = (params: Record<string, string | number | undefined | null>) => {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v))
  const s = p.toString()
  return s ? `?${s}` : ''
}

/** Загрузка файла с прогрессом (fetch не умеет прогресс отправки). */
function upload<T>(path: string, form: FormData, onProgress?: (pct: number) => void): Promise<T> {
  // Моки в странице перехватывают только fetch — загрузка без прогресса
  if (typeof window !== 'undefined' && window.__REQCHECK_INPAGE_MOCKS__)
    return request<T>(path, { method: 'POST', body: form }).then((r) => {
      onProgress?.(100)
      return r
    })
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${API_BASE}${path}`)
    xhr.withCredentials = true
    xhr.setRequestHeader('Accept', 'application/json')
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(Math.round((e.loaded / e.total) * 100))
    xhr.onload = () => {
      let body: { detail?: string; code?: string } | undefined
      try {
        body = JSON.parse(xhr.responseText)
      } catch {
        body = undefined
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as T)
      else {
        if (xhr.status === 401) unauthorizedHandler?.()
        reject(new ApiError(xhr.status, body?.detail ?? `${xhr.status} ${xhr.statusText}`, body?.code))
      }
    }
    xhr.onerror = () => reject(new ApiError(0, 'Network error'))
    xhr.send(form)
  })
}

export const api = {
  // --- auth
  login: (username: string, password: string) =>
    request<{ user: User } | User>('/auth/login', { method: 'POST', json: { username, password } }).then(unwrapUser),
  logout: () => request<void>('/auth/logout', { method: 'POST' }),
  me: () => request<User>('/auth/me'),
  updateMe: (body: { locale?: string; password?: { current: string; new: string } }) =>
    request<{ user: User } | User>('/auth/me', { method: 'PATCH', json: body }).then(unwrapUser),

  // --- providers
  providers: () => request<ProviderSettings[]>('/providers'),
  updateProvider: (p: ProviderId, body: ProviderUpdate) =>
    request<ProviderSettings>(`/providers/${p}`, { method: 'PUT', json: body }),
  testProvider: (p: ProviderId, body: ProviderTestRequest = {}, signal?: AbortSignal) =>
    request<ProviderTestResult>(`/providers/${p}/test`, { method: 'POST', json: body, signal }),
  models: (p: ProviderId) => request<ModelsResponse>(`/providers/${p}/models`),

  // --- documents
  documents: (params: { limit?: number; offset?: number; q?: string } = {}) =>
    request<Page<DocumentItem>>(`/documents${qs(params)}`),
  document: (id: string) => request<DocumentItem>(`/documents/${id}`),
  uploadDocument: (file: File, onProgress?: (pct: number) => void) => {
    const form = new FormData()
    form.append('file', file)
    return upload<DocumentItem>('/documents', form, onProgress)
  },
  deleteDocument: (id: string) => request<void>(`/documents/${id}`, { method: 'DELETE' }),
  documentFileUrl: (id: string) => `${API_BASE}/documents/${id}/file`,

  // --- runs
  runs: (params: { document_id?: string; status?: string; limit?: number; offset?: number } = {}) =>
    request<Page<Run>>(`/runs${qs(params)}`),
  run: (id: string) => request<Run>(`/runs/${id}`),
  createRun: (body: RunCreate) => request<Run>('/runs', { method: 'POST', json: body }),
  cancelRun: (id: string) => request<Run>(`/runs/${id}/cancel`, { method: 'POST' }),
  deleteRun: (id: string) => request<void>(`/runs/${id}`, { method: 'DELETE' }),
  runEventsUrl: (id: string) => `${API_BASE}/runs/${id}/events`,
  report: (id: string) => request<Report>(`/runs/${id}/report`),
  reportExportUrl: (id: string, fmt: ExportFormat) => `${API_BASE}/runs/${id}/report.${fmt}`,
  findings: (id: string) => request<FindingWithReview[]>(`/runs/${id}/findings`),
  reviewFinding: (runId: string, findingId: string, body: { status: ReviewStatus; comment?: string }) =>
    request<FindingReview>(`/runs/${runId}/findings/${findingId}`, { method: 'PATCH', json: body }),

  // --- chat
  chat: (runId: string) => request<ChatMessage[]>(`/runs/${runId}/chat`),
  clearChat: (runId: string) => request<void>(`/runs/${runId}/chat`, { method: 'DELETE' }),

  // --- search & knowledge
  search: (params: { q: string; kind?: 'requirement' | 'finding'; limit?: number }) =>
    request<SearchHit[]>(`/search${qs(params)}`),
  knowledge: () => request<KnowledgeItem[]>('/knowledge'),
  uploadKnowledge: (file: File) => {
    const form = new FormData()
    form.append('file', file)
    return upload<KnowledgeItem>('/knowledge', form)
  },
  addKnowledgeText: (title: string, text: string) =>
    request<KnowledgeItem>('/knowledge', { method: 'POST', json: { title, text } }),
  deleteKnowledge: (id: string) => request<void>(`/knowledge/${id}`, { method: 'DELETE' }),

  // --- service
  health: () => request<Health>('/health'),
  usage: (params: { from?: string; to?: string } = {}) => request<UsageResponse>(`/usage${qs(params)}`),
  audit: (params: { limit?: number; offset?: number } = {}) => request<Page<AuditEntry>>(`/audit${qs(params)}`),
}

function unwrapUser(r: { user: User } | User): User {
  return 'user' in r ? r.user : r
}

export interface ChatStreamHandlers {
  onToken: (text: string) => void
  onDone: (msg: ChatMessage) => void
  signal?: AbortSignal
}

/** POST /runs/{id}/chat → SSE: event token {text}, в конце event done (ChatMessage). */
export async function streamChat(
  runId: string,
  body: { message: string; provider?: string; model?: string },
  { onToken, onDone, signal }: ChatStreamHandlers,
): Promise<void> {
  const res = await fetch(`${API_BASE}/runs/${runId}/chat`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  })
  if (res.status === 401) unauthorizedHandler?.()
  if (!res.ok || !res.body) throw await toError(res)
  for await (const msg of readSSE(res.body, signal)) {
    if (msg.event === 'token') onToken(JSON.parse(msg.data).text ?? '')
    else if (msg.event === 'done') onDone(JSON.parse(msg.data))
    else if (msg.event === 'error') {
      const e = JSON.parse(msg.data)
      throw new ApiError(500, e.detail ?? 'Stream error', e.code)
    }
  }
}
