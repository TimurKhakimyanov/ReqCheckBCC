// MSW-обработчики для всех методов docs/api.md. Включаются VITE_USE_MOCKS=true (браузер) и в тестах (node).
import { delay, http, HttpResponse, type JsonBodyType, type PathParams } from 'msw'
import { formatSSE } from '@/api/sse'
import type { DocumentFormat, ExportFormat, FindingReview, ProviderId, ReviewStatus, RunCreate } from '@/api/types'
import { isTerminal, PROVIDERS } from '@/api/types'
import {
  chatAnswer,
  db,
  logAudit,
  materialize,
  MODELS,
  newRun,
  progressOf,
  sampleReport,
  setSession,
  uid,
} from './data'

const A = (p: string) => `*/api${p}`
const err = (status: number, detail: string, code = 'error') => HttpResponse.json({ detail, code }, { status })
const LATENCY = import.meta.env.MODE === 'test' ? 0 : 150

function authed() {
  return db.loggedIn
}

type Info = { request: Request; params: Record<string, string> }

/** Обёртка: 401 без сессии, небольшая задержка для реалистичности. */
function guard(fn: (info: Info) => Response | Promise<Response>) {
  return async ({ request, params }: { request: Request; params: PathParams }): Promise<Response> => {
    if (LATENCY) await delay(LATENCY)
    if (!authed()) return err(401, 'Not authenticated', 'not_authenticated')
    return fn({ request, params: params as Record<string, string> })
  }
}

function sseStream(producer: (send: (event: string, data: unknown) => void, close: () => void) => () => void, signal: AbortSignal) {
  const enc = new TextEncoder()
  let cleanup: () => void = () => {}
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false
      const close = () => {
        if (closed) return
        closed = true
        cleanup()
        try {
          controller.close()
        } catch {
          /* already closed */
        }
      }
      cleanup = producer((event, data) => !closed && controller.enqueue(enc.encode(formatSSE(event, data))), close)
      signal.addEventListener('abort', close)
    },
    cancel() {
      cleanup()
    },
  })
  return new HttpResponse(stream, {
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' },
  })
}

function reviewsFor(runId: string): Record<string, FindingReview> {
  return (db.reviews[runId] ??= {})
}

function exportBody(runId: string, fmt: ExportFormat): { body: BodyInit; type: string } {
  const r = db.reports[runId]
  if (fmt === 'json') return { body: JSON.stringify(r, null, 2), type: 'application/json' }
  const md = [
    `# Отчёт о проверке требований: ${r.passport.document_name}`,
    '',
    `Модель: ${r.passport.provider} / ${r.passport.model}`,
    '',
    `## Итог`,
    r.conclusion.rationale,
    '',
    `## Дефекты`,
    ...r.findings.map((f) => `- **${f.id}** [${f.severity}] ${f.title}`),
    '',
    '_Выгрузка мок-сервера. Настоящие PDF/DOCX формирует бэкенд._',
  ].join('\n')
  const types: Record<ExportFormat, string> = {
    md: 'text/markdown',
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    json: 'application/json',
  }
  return { body: md, type: types[fmt] }
}

export const handlers = [
  // ---------------- auth
  http.post(A('/auth/login'), async ({ request }) => {
    if (LATENCY) await delay(LATENCY * 2)
    const { username, password } = (await request.json()) as { username: string; password: string }
    if (username !== db.user.username || password !== db.password) return err(401, 'Invalid credentials', 'invalid_credentials')
    setSession(true)
    logAudit('auth.login', db.user.username)
    return HttpResponse.json({ user: db.user })
  }),
  http.post(A('/auth/logout'), () => {
    setSession(false)
    return new HttpResponse(null, { status: 204 })
  }),
  http.get(A('/auth/me'), guard(() => HttpResponse.json(db.user))),
  http.patch(
    A('/auth/me'),
    guard(async ({ request }: { request: Request }) => {
      const body = (await request.json()) as { locale?: string; password?: { current: string; new: string } }
      if (body.password) {
        if (body.password.current !== db.password) return err(400, 'Current password is wrong', 'wrong_password')
        if (body.password.new.length < 8) return err(422, 'Password must be at least 8 characters', 'weak_password')
        db.password = body.password.new
        logAudit('auth.password_change', db.user.username)
      }
      if (body.locale) db.user.locale = body.locale
      return HttpResponse.json({ user: db.user })
    }),
  ),

  // ---------------- providers
  http.get(A('/providers'), guard(() => HttpResponse.json(PROVIDERS.map((p) => strip(db.providers[p]))))),
  http.put(
    A('/providers/:provider'),
    guard(async ({ request, params }: { request: Request; params: Record<string, string> }) => {
      const p = db.providers[params.provider as ProviderId]
      if (!p) return err(404, 'Unknown provider')
      const body = (await request.json()) as { api_key?: string; base_url?: string; enabled?: boolean; default_model?: string }
      if (body.api_key !== undefined) {
        p._key = body.api_key || undefined
        p.has_key = !!body.api_key
        p.key_hint = body.api_key ? `…${body.api_key.slice(-4)}` : null
      }
      if (body.base_url !== undefined) p.base_url = body.base_url || null
      if (body.enabled !== undefined) p.enabled = body.enabled
      if (body.default_model !== undefined) p.default_model = body.default_model || null
      p.updated_at = new Date().toISOString()
      logAudit('provider.update', p.provider, { fields: Object.keys(body).filter((k) => k !== 'api_key').concat(body.api_key !== undefined ? ['api_key'] : []) })
      return HttpResponse.json(strip(p))
    }),
  ),
  http.post(
    A('/providers/:provider/test'),
    guard(async ({ params }: { params: Record<string, string> }) => {
      const p = db.providers[params.provider as ProviderId]
      if (!p) return err(404, 'Unknown provider')
      await delay(import.meta.env.MODE === 'test' ? 0 : 700)
      const ok = p.has_key || (p.provider === 'openai_compatible' && !!p.base_url)
      return HttpResponse.json({ ok, latency_ms: ok ? 412 : 0, error: ok ? null : 'API key is not set' })
    }),
  ),
  http.get(
    A('/providers/:provider/models'),
    guard(({ params }: { params: Record<string, string> }) => {
      const models = MODELS[params.provider as ProviderId]
      return models ? HttpResponse.json({ models }) : err(404, 'Unknown provider')
    }),
  ),

  // ---------------- documents
  http.get(
    A('/documents'),
    guard(({ request }: { request: Request }) => {
      const url = new URL(request.url)
      const q = (url.searchParams.get('q') ?? '').toLowerCase()
      const limit = Number(url.searchParams.get('limit') ?? 50)
      const offset = Number(url.searchParams.get('offset') ?? 0)
      // актуализировать статусы прогонов, чтобы last_run был свежим
      db.runs.forEach(materialize)
      const items = db.documents.filter((d) => !q || d.name.toLowerCase().includes(q))
      return HttpResponse.json({ items: items.slice(offset, offset + limit), total: items.length })
    }),
  ),
  http.post(
    A('/documents'),
    guard(async ({ request }: { request: Request }) => {
      const form = await request.formData()
      const file = form.get('file')
      if (!(file instanceof File)) return err(422, 'File is required', 'file_required')
      const ext = file.name.split('.').pop()?.toLowerCase() as DocumentFormat
      if (!['pdf', 'docx', 'md', 'txt'].includes(ext)) return err(415, 'Unsupported format', 'unsupported_format')
      if (file.size > 25 * 1024 * 1024) return err(413, 'File is too large', 'too_large')
      const doc = {
        id: uid('doc'),
        name: file.name,
        format: ext,
        size_bytes: file.size,
        sha256: Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join(''),
        created_at: new Date().toISOString(),
        runs_count: 0,
        last_run: null,
      }
      db.documents.unshift(doc)
      db.docTexts[doc.id] = ext === 'md' || ext === 'txt' ? await file.text() : sampleReport.document.text
      logAudit('document.upload', doc.id, { name: doc.name })
      return HttpResponse.json(doc, { status: 201 })
    }),
  ),
  http.get(
    A('/documents/:id'),
    guard(({ params }: { params: Record<string, string> }) => {
      const d = db.documents.find((x) => x.id === params.id)
      return d ? HttpResponse.json(d) : err(404, 'Document not found', 'not_found')
    }),
  ),
  http.get(
    A('/documents/:id/file'),
    guard(({ params }: { params: Record<string, string> }) => {
      const d = db.documents.find((x) => x.id === params.id)
      if (!d) return err(404, 'Document not found', 'not_found')
      return new HttpResponse(db.docTexts[d.id] ?? '', {
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="${encodeURIComponent(d.name)}"` },
      })
    }),
  ),
  http.delete(
    A('/documents/:id'),
    guard(({ params }: { params: Record<string, string> }) => {
      db.documents = db.documents.filter((d) => d.id !== params.id)
      db.runs = db.runs.filter((r) => r.document_id !== params.id)
      logAudit('document.delete', String(params.id))
      return new HttpResponse(null, { status: 204 })
    }),
  ),

  // ---------------- runs
  http.get(
    A('/runs'),
    guard(({ request }: { request: Request }) => {
      const url = new URL(request.url)
      const docId = url.searchParams.get('document_id')
      const status = url.searchParams.get('status')
      const limit = Number(url.searchParams.get('limit') ?? 50)
      const offset = Number(url.searchParams.get('offset') ?? 0)
      const items = db.runs
        .map(materialize)
        .filter((r) => (!docId || r.document_id === docId) && (!status || r.status === status))
      return HttpResponse.json({ items: items.slice(offset, offset + limit), total: items.length })
    }),
  ),
  http.post(
    A('/runs'),
    guard(async ({ request }: { request: Request }) => {
      const body = (await request.json()) as RunCreate
      const doc = db.documents.find((d) => d.id === body.document_id)
      if (!doc) return err(404, 'Document not found', 'not_found')
      const prov = db.providers[body.provider as ProviderId]
      if (!prov) return err(422, 'Unknown provider', 'unknown_provider')
      if (!prov.has_key && body.provider !== 'openai_compatible')
        return err(422, `Provider ${body.provider} has no API key. Add it in Settings.`, 'provider_not_configured')
      const run = newRun(doc, body.provider, body.model, body.options ?? {})
      logAudit('run.create', run.id, { provider: body.provider, model: body.model })
      return HttpResponse.json(materialize(run), { status: 202 })
    }),
  ),
  http.get(
    A('/runs/:id'),
    guard(({ params }: { params: Record<string, string> }) => {
      const r = db.runs.find((x) => x.id === params.id)
      return r ? HttpResponse.json(materialize(r)) : err(404, 'Run not found', 'not_found')
    }),
  ),
  http.post(
    A('/runs/:id/cancel'),
    guard(({ params }: { params: Record<string, string> }) => {
      const r = db.runs.find((x) => x.id === params.id)
      if (!r) return err(404, 'Run not found', 'not_found')
      materialize(r)
      if (!isTerminal(r.status)) {
        r.status = 'cancelled'
        r.stage = 'cancelled'
        r.finished_at = new Date().toISOString()
        logAudit('run.cancel', r.id)
      }
      return HttpResponse.json(materialize(r))
    }),
  ),
  http.delete(
    A('/runs/:id'),
    guard(({ params }: { params: Record<string, string> }) => {
      const r = db.runs.find((x) => x.id === params.id)
      db.runs = db.runs.filter((x) => x.id !== params.id)
      const doc = r && db.documents.find((d) => d.id === r.document_id)
      if (doc) doc.runs_count = Math.max(0, doc.runs_count - 1)
      logAudit('run.delete', String(params.id))
      return new HttpResponse(null, { status: 204 })
    }),
  ),
  http.get(A('/runs/:id/events'), ({ params, request }) => {
    if (!authed()) return err(401, 'Not authenticated')
    const r = db.runs.find((x) => x.id === params.id)
    if (!r) return err(404, 'Run not found', 'not_found')
    return sseStream((send, close) => {
      let last = ''
      let timer: ReturnType<typeof setTimeout>
      const tick = () => {
        const ev = progressOf(r)
        materialize(r)
        const key = `${ev.stage}:${ev.current ?? ''}`
        if (key !== last) {
          send('progress', ev)
          last = key
        }
        if (isTerminal(ev.stage)) return close()
        timer = setTimeout(tick, 150)
      }
      tick()
      return () => clearTimeout(timer)
    }, request.signal)
  }),
  http.get(
    A('/runs/:id/report'),
    guard(({ params }: { params: Record<string, string> }) => {
      const rep = db.reports[params.id]
      return rep ? HttpResponse.json(rep as unknown as JsonBodyType) : err(404, 'Report is not ready', 'report_not_ready')
    }),
  ),
  http.get(
    A('/runs/:id/findings'),
    guard(({ params }: { params: Record<string, string> }) => {
      const rep = db.reports[params.id]
      if (!rep) return err(404, 'Report is not ready', 'report_not_ready')
      const rv = reviewsFor(params.id)
      return HttpResponse.json(
        rep.findings.map((f) => ({ finding: f, review: rv[f.id] ?? { finding_id: f.id, status: 'open', comment: null, updated_at: null } })) as unknown as JsonBodyType,
      )
    }),
  ),
  http.patch(
    A('/runs/:id/findings/:fid'),
    guard(async ({ params, request }: { params: Record<string, string>; request: Request }) => {
      const body = (await request.json()) as { status: ReviewStatus; comment?: string }
      const review: FindingReview = { finding_id: params.fid, status: body.status, comment: body.comment ?? null, updated_at: new Date().toISOString() }
      reviewsFor(params.id)[params.fid] = review
      logAudit('finding.review', `${params.id}/${params.fid}`, { status: body.status })
      return HttpResponse.json(review)
    }),
  ),

  // ---------------- chat
  http.get(A('/runs/:id/chat'), guard(({ params }: { params: Record<string, string> }) => HttpResponse.json(db.chats[params.id] ?? []))),
  http.delete(
    A('/runs/:id/chat'),
    guard(({ params }: { params: Record<string, string> }) => {
      delete db.chats[params.id]
      return new HttpResponse(null, { status: 204 })
    }),
  ),
  http.post(A('/runs/:id/chat'), async ({ params, request }) => {
    if (!authed()) return err(401, 'Not authenticated')
    const runId = String(params.id)
    const rep = db.reports[runId]
    if (!rep) return err(404, 'Report is not ready', 'report_not_ready')
    const { message } = (await request.json()) as { message: string }
    const history = (db.chats[runId] ??= [])
    history.push({ id: uid('m'), role: 'user', content: message, created_at: new Date().toISOString() })
    const answer = chatAnswer(message, rep)
    const tokens = answer.match(/\S+\s*|\s+/g) ?? [answer]
    const step = import.meta.env.MODE === 'test' ? 0 : 35
    return sseStream((send, close) => {
      let i = 0
      let timer: ReturnType<typeof setTimeout>
      const tick = () => {
        if (i < tokens.length) {
          send('token', { text: tokens[i++] })
          timer = setTimeout(tick, step)
          return
        }
        const msg = { id: uid('m'), role: 'assistant' as const, content: answer, created_at: new Date().toISOString() }
        history.push(msg)
        send('done', msg)
        close()
      }
      tick()
      return () => clearTimeout(timer)
    }, request.signal)
  }),

  // /runs/{id}/report.{md,pdf,docx,json} — после /findings и /chat, чтобы не перехватывать их
  http.get(
    A('/runs/:id/:file'),
    guard(({ params }: { params: Record<string, string> }) => {
      const m = /^report\.(md|pdf|docx|json)$/.exec(params.file)
      if (!m) return err(404, 'Not found')
      if (!db.reports[params.id]) return err(404, 'Report is not ready', 'report_not_ready')
      const fmt = m[1] as ExportFormat
      const { body, type } = exportBody(params.id, fmt)
      return new HttpResponse(body, {
        headers: { 'Content-Type': type, 'Content-Disposition': `attachment; filename="report-${params.id}.${fmt}"` },
      })
    }),
  ),

  // ---------------- search & knowledge
  http.get(
    A('/search'),
    guard(({ request }: { request: Request }) => {
      const url = new URL(request.url)
      const q = (url.searchParams.get('q') ?? '').toLowerCase().trim()
      const kind = url.searchParams.get('kind')
      const limit = Number(url.searchParams.get('limit') ?? 20)
      if (!q) return HttpResponse.json([])
      const words = q.split(/\s+/)
      const score = (text: string) => {
        const t = text.toLowerCase()
        const hits = words.filter((w) => t.includes(w)).length
        return hits / words.length
      }
      const hits = []
      for (const [runId, rep] of Object.entries(db.reports)) {
        const docName = rep.passport.document_name
        if (kind !== 'finding')
          for (const r of rep.requirements) {
            const text = `${r.summary}. ${r.location.quote}`
            hits.push({ score: score(text), kind: 'requirement', text, run_id: runId, document_name: docName, requirement_id: r.id })
          }
        if (kind !== 'requirement')
          for (const f of rep.findings) {
            const text = `${f.title}. ${f.explanation}`
            hits.push({ score: score(text), kind: 'finding', text, run_id: runId, document_name: docName, finding_id: f.id })
          }
      }
      return HttpResponse.json(
        hits
          .filter((h) => h.score > 0)
          .map((h) => ({ ...h, score: Math.round((0.55 + h.score * 0.4 + Math.random() * 0.04) * 1000) / 1000 }))
          .sort((a, b) => b.score - a.score)
          .slice(0, limit),
      )
    }),
  ),
  http.get(
    A('/knowledge'),
    guard(() => {
      const t = Date.now()
      db.knowledge.forEach((k) => {
        if (k.status === 'indexing' && k._readyAt && t >= k._readyAt) k.status = 'ready'
      })
      return HttpResponse.json(db.knowledge.map(strip))
    }),
  ),
  http.post(
    A('/knowledge'),
    guard(async ({ request }: { request: Request }) => {
      const ct = request.headers.get('content-type') ?? ''
      let title: string
      let size: number
      let source: 'upload' | 'manual'
      if (ct.includes('multipart/form-data')) {
        const file = (await request.formData()).get('file')
        if (!(file instanceof File)) return err(422, 'File is required')
        title = file.name
        size = file.size
        source = 'upload'
      } else {
        const body = (await request.json()) as { title: string; text: string }
        if (!body.title || !body.text) return err(422, 'Title and text are required')
        title = body.title
        size = body.text.length
        source = 'manual'
      }
      const item = {
        id: uid('kb'),
        title,
        source,
        chunks: Math.max(1, Math.round(size / 800)),
        status: 'indexing' as const,
        created_at: new Date().toISOString(),
        _readyAt: Date.now() + 3000,
      }
      db.knowledge.unshift(item)
      logAudit('knowledge.add', item.id, { title })
      return HttpResponse.json(strip(item), { status: 201 })
    }),
  ),
  http.delete(
    A('/knowledge/:id'),
    guard(({ params }: { params: Record<string, string> }) => {
      db.knowledge = db.knowledge.filter((k) => k.id !== params.id)
      logAudit('knowledge.delete', String(params.id))
      return new HttpResponse(null, { status: 204 })
    }),
  ),

  // ---------------- service
  http.get(A('/health'), () =>
    HttpResponse.json({ status: 'ok', version: 'mock', checks: { postgres: 'ok', redis: 'ok', qdrant: 'ok', s3: 'ok', embedder: 'ok' } }),
  ),
  http.get(
    A('/usage'),
    guard(() => {
      const by_day = Array.from({ length: 14 }, (_, i) => {
        const d = new Date(Date.now() - (13 - i) * 86_400_000)
        const calls = Math.round(4 + 10 * Math.abs(Math.sin(i * 1.7)))
        return {
          day: d.toISOString().slice(0, 10),
          llm_calls: calls,
          prompt_tokens: calls * 3400,
          completion_tokens: calls * 640,
          cost_usd: Math.round(calls * 0.0023 * 1000) / 1000,
        }
      })
      const sum = (k: 'llm_calls' | 'prompt_tokens' | 'completion_tokens' | 'cost_usd') => by_day.reduce((s, d) => s + d[k], 0)
      const totals = { llm_calls: sum('llm_calls'), prompt_tokens: sum('prompt_tokens'), completion_tokens: sum('completion_tokens'), cost_usd: Math.round(sum('cost_usd') * 1000) / 1000 }
      const share = [
        { provider: 'gemini', model: 'gemini-2.5-flash', k: 0.7 },
        { provider: 'openai', model: 'gpt-4.1-mini', k: 0.2 },
        { provider: 'openai_compatible', model: 'qwen2.5:7b-instruct', k: 0.1 },
      ]
      const by_provider = share.map(({ provider, model, k }) => ({
        provider,
        model,
        llm_calls: Math.round(totals.llm_calls * k),
        prompt_tokens: Math.round(totals.prompt_tokens * k),
        completion_tokens: Math.round(totals.completion_tokens * k),
        cost_usd: provider === 'openai_compatible' ? 0 : Math.round(totals.cost_usd * k * 1000) / 1000,
      }))
      return HttpResponse.json({ totals, by_provider, by_day })
    }),
  ),
  http.get(
    A('/audit'),
    guard(({ request }: { request: Request }) => {
      const url = new URL(request.url)
      const limit = Number(url.searchParams.get('limit') ?? 50)
      const offset = Number(url.searchParams.get('offset') ?? 0)
      return HttpResponse.json({ items: db.audit.slice(offset, offset + limit) as unknown as JsonBodyType, total: db.audit.length })
    }),
  ),
]

function strip<T extends object>(o: T): T {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o)) if (!k.startsWith('_')) out[k] = v
  return out as T
}
