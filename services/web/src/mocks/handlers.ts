// MSW-обработчики для всех методов docs/api.md. Включаются VITE_USE_MOCKS=true (браузер) и в тестах (node).
import { delay, http, HttpResponse, type JsonBodyType, type PathParams } from 'msw'
import { formatSSE } from '@/api/sse'
import type { AppSettingsUpdate, DocumentFormat, ExportFormat, FindingReview, ProviderId, ProviderUpdate, ReviewStatus, RunCreate } from '@/api/types'
import { EMBEDDINGS_DIM_LIMITS, EMBEDDINGS_PROVIDERS, isProviderConfigured, isTerminal, PROVIDERS, SETTING_LIMITS } from '@/api/types'
import {
  answerRun,
  chatAnswer,
  db,
  isAsking,
  logAudit,
  materialize,
  MODELS,
  newRun,
  probeProvider,
  progressOf,
  sampleReport,
  setSession,
  uid,
} from './data'
import { mockRunLogs } from './runlogs'
import {
  folderList,
  movePath,
  normFolder,
  parentOf,
  renameLinks,
  search as wikiSearch,
  detail as wikiDetail,
  graph as wikiGraph,
  within,
} from './wiki'

const A = (p: string) => `*/api${p}`

/** Content-Disposition как у бэкенда: ASCII-запасное имя + filename* в UTF-8 (кириллица). */
function contentDisposition(name: string) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}
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

type Producer = (send: (event: string, data: unknown) => void, close: () => void, raw: (text: string) => void) => () => void

function sseStream(producer: Producer, signal: AbortSignal) {
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
      const raw = (text: string) => {
        if (!closed) controller.enqueue(enc.encode(text))
      }
      cleanup = producer((event, data) => raw(formatSSE(event, data)), close, raw)
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
        if (body.password.current !== db.password) return err(400, 'Текущий пароль неверен', 'wrong_password')
        if (body.password.new.length < 8)
          return HttpResponse.json(
            {
              detail: 'Некорректные данные: password.new: String should have at least 8 characters',
              code: 'validation_error',
              errors: [{ loc: ['body', 'password', 'new'], msg: 'String should have at least 8 characters', type: 'string_too_short' }],
            },
            { status: 422 },
          )
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
      const body = (await request.json()) as ProviderUpdate
      const errors: { loc: (string | number)[]; msg: string; type: string }[] = []
      for (const k of ['extra_body', 'extra_body_set_review'] as const) {
        const v = body[k]
        if (v !== undefined && v !== null && (typeof v !== 'object' || Array.isArray(v)))
          errors.push({ loc: ['body', k], msg: 'Input should be a valid dictionary', type: 'dict_type' })
      }
      const mot = body.max_output_tokens
      if (mot !== undefined && mot !== null && (!Number.isInteger(mot) || mot < 1))
        errors.push({ loc: ['body', 'max_output_tokens'], msg: 'Input should be a positive integer', type: 'int_type' })
      const to = body.timeout_s
      if (to !== undefined && to !== null && (!Number.isInteger(to) || to < 10 || to > 3600))
        errors.push({ loc: ['body', 'timeout_s'], msg: 'Input should be between 10 and 3600', type: 'range' })
      if (errors.length)
        return HttpResponse.json({ detail: `Некорректные данные: ${errors[0].loc[1]}: ${errors[0].msg}`, code: 'validation_error', errors }, { status: 422 })
      if (body.timeout_s !== undefined) p.timeout_s = body.timeout_s
      if (body.extra_body !== undefined) p.extra_body = body.extra_body
      if (body.extra_body_set_review !== undefined) p.extra_body_set_review = body.extra_body_set_review
      if (body.max_output_tokens !== undefined) p.max_output_tokens = body.max_output_tokens
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
    guard(async ({ request, params }) => {
      const p = db.providers[params.provider as ProviderId]
      if (!p) return err(404, 'Unknown provider', 'not_found')
      // тело — ещё не сохранённые поля формы; пустые поля берутся из сохранённых настроек
      const body = ((await request.json().catch(() => ({}))) ?? {}) as { api_key?: string; base_url?: string }
      await delay(import.meta.env.MODE === 'test' ? 0 : 600)
      const key = body.api_key || p._key || (p.has_key ? 'saved-key-a1b2' : undefined)
      const res = probeProvider(p.provider, key, body.base_url ?? p.base_url)
      // как бэкенд: короткий запрос к модели по умолчанию; модели нет у провайдера — 404, но список всё равно отдаём
      const valid = res.ok && p.default_model ? res.models.includes(p.default_model) : null
      if (valid === false)
        return HttpResponse.json({
          ok: false,
          latency_ms: 180,
          error: `NotFoundError: Error code: 404 - {'type': 'error', 'error': {'type': 'not_found_error', 'message': 'model: ${p.default_model}'}}`,
          models: res.models,
          default_model_valid: false,
          warning: `Модель по умолчанию «${p.default_model}» не найдена у провайдера`,
        })
      return HttpResponse.json({
        ok: res.ok,
        latency_ms: res.ok ? 412 : 35,
        error: res.error ?? null,
        models: res.models,
        default_model_valid: valid,
        warning: null,
      })
    }),
  ),
  http.get(
    A('/providers/:provider/models'),
    guard(({ params }) => {
      const p = db.providers[params.provider as ProviderId]
      if (!p) return err(404, 'Unknown provider', 'not_found')
      // как бэкенд: всегда 200; без доступа к провайдеру — список-подсказка и текст ошибки
      const res = probeProvider(p.provider, p._key || (p.has_key ? 'saved-key-a1b2' : undefined), p.base_url)
      if (res.ok)
        return HttpResponse.json({
          models: res.models,
          default_model_valid: p.default_model ? res.models.includes(p.default_model) : null,
        })
      return HttpResponse.json({ models: MODELS[p.provider], error: res.error })
    }),
  ),

  // ---------------- AI settings (admin)
  http.get(
    A('/settings'),
    guard(() => HttpResponse.json(strip(db.settings) as unknown as JsonBodyType)),
  ),
  http.put(
    A('/settings'),
    guard(async ({ request }) => {
      // как app_settings.update_settings бэкенда: частичное обновление, плоские поля
      const body = (await request.json()) as AppSettingsUpdate
      const errors: { loc: (string | number)[]; msg: string; type: string }[] = []
      const ranges: Record<string, { min: number; max: number }> = { ...SETTING_LIMITS, embeddings_dim: EMBEDDINGS_DIM_LIMITS }
      for (const [k, lim] of Object.entries(ranges)) {
        const v = (body as Record<string, unknown>)[k]
        if (v === undefined || v === null) continue
        if (typeof v !== 'number' || Number.isNaN(v) || v < lim.min || v > lim.max)
          errors.push({ loc: ['body', k], msg: `Input should be between ${lim.min} and ${lim.max}`, type: 'range' })
      }
      if (body.default_provider && !PROVIDERS.includes(body.default_provider))
        errors.push({ loc: ['body', 'default_provider'], msg: 'Unknown provider', type: 'enum' })
      if (body.embeddings_provider && !EMBEDDINGS_PROVIDERS.includes(body.embeddings_provider))
        errors.push({ loc: ['body', 'embeddings_provider'], msg: 'Unknown embeddings provider', type: 'enum' })
      if (errors.length)
        return HttpResponse.json(
          { detail: `Некорректные данные: ${errors[0].loc.slice(1).join('.')}: ${errors[0].msg}`, code: 'validation_error', errors },
          { status: 422 },
        )
      const st = db.settings
      const { embeddings_api_key: key, ...changes } = body
      for (const [k, v] of Object.entries(changes)) {
        const nullable = ['default_model', 'embeddings_model', 'embeddings_dim'].includes(k)
        if (v === undefined || (v === null && !nullable)) continue
        ;(st as unknown as Record<string, unknown>)[k] = nullable && v === '' ? null : v
      }
      if (key !== undefined) {
        const k = key.trim()
        st._embeddingsKey = k || undefined
        st.embeddings_has_key = !!k
        st.embeddings_key_hint = k ? `…${k.slice(-4)}` : null
      }
      st.updated_at = new Date().toISOString()
      logAudit('settings_updated', null, { fields: Object.keys(body).sort() })
      return HttpResponse.json(strip(st) as unknown as JsonBodyType)
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
      if (!(file instanceof File)) return err(422, 'Некорректные данные: file: Field required', 'validation_error')
      const ext = file.name.split('.').pop()?.toLowerCase() as DocumentFormat
      if (!['pdf', 'docx', 'md', 'txt'].includes(ext))
        return err(415, 'Формат не поддерживается: нужен PDF, DOCX, MD или TXT', 'unsupported_format')
      if (file.size > db.settings.max_upload_mb * 1024 * 1024) return err(413, `Файл больше ${db.settings.max_upload_mb} МБ`, 'file_too_large')
      if (file.size === 0) return err(400, 'Файл пустой', 'empty_file')
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
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': contentDisposition(d.name) },
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
      // provider/model необязательны: по умолчанию — первый провайдер с ключом и его модель
      const fallback = db.settings.default_provider ? db.providers[db.settings.default_provider] : undefined
      const prov = body.provider
        ? db.providers[body.provider as ProviderId]
        : fallback && isProviderConfigured(fallback)
          ? fallback
          : PROVIDERS.map((p) => db.providers[p]).find((p) => p.enabled && isProviderConfigured(p))
      if (!prov) return err(400, 'Нет провайдера с ключом. Добавьте ключ в кабинете.', 'provider_not_configured')
      if (!isProviderConfigured(prov))
        return err(400, `Провайдер ${prov.provider} не настроен: задайте ключ (или адрес для локальной модели) в кабинете.`, 'provider_not_configured')
      const model =
        body.model ||
        (!body.provider && db.settings.default_provider === prov.provider ? db.settings.default_model : null) ||
        prov.default_model ||
        MODELS[prov.provider][0]
      const run = newRun(doc, prov.provider, model, body.options ?? {})
      logAudit('run.create', run.id, { provider: prov.provider, model })
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
  http.get(
    A('/runs/:id/questions'),
    guard(({ params }: { params: Record<string, string> }) => {
      const r = db.runs.find((x) => x.id === params.id)
      if (!r) return err(404, 'Run not found', 'not_found')
      materialize(r)
      return HttpResponse.json(isAsking(r) ? { waiting: true, questions: sampleReport.questions ?? [] } : { waiting: false, questions: [] })
    }),
  ),
  http.post(
    A('/runs/:id/answers'),
    guard(async ({ params, request }: { params: Record<string, string>; request: Request }) => {
      const r = db.runs.find((x) => x.id === params.id)
      if (!r) return err(404, 'Run not found', 'not_found')
      materialize(r)
      if (!isAsking(r)) return err(409, 'Прогон сейчас не ждёт ответов автора', 'not_waiting')
      const { answers = {} } = (await request.json()) as { answers?: Record<string, string> }
      const ids = new Set((sampleReport.questions ?? []).map((q) => q.id))
      const clean = Object.fromEntries(Object.entries(answers).filter(([k, v]) => ids.has(k) && v?.trim()).map(([k, v]) => [k, v.trim()]))
      answerRun(r, clean)
      logAudit('run_answers', r.id, { answered: Object.keys(clean) })
      return HttpResponse.json({ waiting: false, questions: [] }, { status: 202 })
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
        r.message = 'Отменён пользователем'
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
    return sseStream((send, close, raw) => {
      let last = ''
      let ticks = 0
      let timer: ReturnType<typeof setTimeout>
      raw('retry: 3000\n\n')
      const tick = () => {
        // как бэкенд: периодический комментарий-keepalive
        if (++ticks % 10 === 0) raw(': keepalive\n\n')
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
      return rep ? HttpResponse.json(rep as unknown as JsonBodyType) : err(404, 'Отчёт ещё не готов', 'report_not_ready')
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
    // Демонстрация event: error — модель «падает» посреди ответа
    const failAfter = /сломай|fail/i.test(message) ? 6 : Infinity
    const step = import.meta.env.MODE === 'test' ? 0 : 35
    return sseStream((send, close) => {
      let i = 0
      let timer: ReturnType<typeof setTimeout>
      const tick = () => {
        if (i >= failAfter) {
          send('error', { detail: 'Модель вернула ошибку 503, попробуйте ещё раз', code: 'chat_failed' })
          return close()
        }
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

  http.get(
    A('/runs/:id/logs'),
    guard(({ params }: { params: Record<string, string> }) => {
      const r = db.runs.find((x) => x.id === params.id)
      if (!r) return err(404, 'Run not found', 'not_found')
      return HttpResponse.json(mockRunLogs(materialize(r), db.audit) as unknown as JsonBodyType)
    }),
  ),

  // /runs/{id}/report.{md,pdf,docx,json} — после /findings и /chat, чтобы не перехватывать их
  http.get(
    A('/runs/:id/:file'),
    guard(({ params }: { params: Record<string, string> }) => {
      const m = /^report\.(md|pdf|docx|json)$/.exec(params.file)
      if (!m) return err(404, 'Not found')
      if (!db.reports[params.id]) return err(404, 'Отчёт ещё не готов', 'report_not_ready')
      const fmt = m[1] as ExportFormat
      // Мок не рисует PDF/DOCX — отвечает так же, как бэкенд без поддержки формата в ядре
      if (fmt === 'pdf' || fmt === 'docx')
        return err(501, `Выгрузка в ${fmt.toUpperCase()} в демо-режиме недоступна`, 'render_unavailable')
      const { body, type } = exportBody(params.id, fmt)
      const name = `${db.reports[params.id].passport.document_name.replace(/\.[^.]+$/, '')} — отчёт.${fmt}`
      return new HttpResponse(body, {
        headers: { 'Content-Type': type, 'Content-Disposition': contentDisposition(name) },
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
      let content = ''
      let folder = ''
      if (ct.includes('multipart/form-data')) {
        const form = await request.formData()
        const file = form.get('file')
        if (!(file instanceof File)) return err(422, 'Некорректные данные: file: Field required', 'validation_error')
        const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
        if (!['pdf', 'docx', 'md', 'txt'].includes(ext)) return err(415, 'Формат не поддерживается', 'unsupported_format')
        if (file.size === 0) return err(400, 'Файл пустой', 'empty_file')
        title = String(form.get('title') || file.name.replace(/\.[^.]+$/, ''))
        size = file.size
        source = 'upload'
        folder = String(form.get('folder') || '')
        content = ['md', 'txt'].includes(ext) ? await file.text() : `# ${title}\n\nТекст извлечён из ${ext.toUpperCase()}.`
      } else {
        const body = (await request.json()) as { title: string; text: string; folder?: string }
        if (!body.title || !body.text)
          return HttpResponse.json(
            {
              detail: `Некорректные данные: ${body.title ? 'text' : 'title'}: Field required`,
              code: 'validation_error',
              errors: [{ loc: ['body', body.title ? 'text' : 'title'], msg: 'Field required', type: 'missing' }],
            },
            { status: 422 },
          )
        title = body.title
        size = body.text.length
        source = 'manual'
        content = body.text
        folder = body.folder ?? ''
      }
      const item = {
        id: uid('kb'),
        title,
        source,
        chunks: Math.max(1, Math.round(size / 800)),
        status: 'indexing' as const,
        created_at: new Date().toISOString(),
        updated_at: null,
        folder: folder.split('/').map((p) => p.trim()).filter(Boolean).join('/'),
        chars: content.length,
        _readyAt: Date.now() + 3000,
        _content: content,
      }
      db.knowledge.unshift(item)
      logAudit('knowledge.add', item.id, { title })
      return HttpResponse.json(strip(item), { status: 201 })
    }),
  ),
  http.get(
    A('/knowledge/graph'),
    guard(() => HttpResponse.json(wikiGraph(db.knowledge, db.knowledgeFolders))),
  ),
  http.get(
    A('/knowledge/search'),
    guard(({ request }: { request: Request }) => {
      const url = new URL(request.url)
      return HttpResponse.json(wikiSearch(db.knowledge, url.searchParams.get('q') ?? '', Number(url.searchParams.get('limit') ?? 20)))
    }),
  ),
  http.get(
    A('/knowledge/folders'),
    guard(() => HttpResponse.json(folderList(db.knowledge, db.knowledgeFolders))),
  ),
  http.post(
    A('/knowledge/folders'),
    guard(async ({ request }: { request: Request }) => {
      const path = normFolder(((await request.json()) as { path?: string }).path ?? '')
      if (!path) return err(400, 'Укажите название папки', 'folder_required')
      if (folderList(db.knowledge, db.knowledgeFolders).some((f) => f.path === path))
        return err(409, `Папка «${path}» уже есть`, 'folder_exists')
      db.knowledgeFolders.push(path)
      logAudit('knowledge_folder_created', path)
      return HttpResponse.json({ path, notes: 0, total: 0, explicit: true }, { status: 201 })
    }),
  ),
  http.patch(
    A('/knowledge/folders'),
    guard(async ({ request }: { request: Request }) => {
      const body = (await request.json()) as { path?: string; new_path?: string }
      const from = normFolder(body.path ?? '')
      const to = normFolder(body.new_path ?? '')
      if (!from || !to) return err(400, 'Укажите название папки', 'folder_required')
      const existing = folderList(db.knowledge, db.knowledgeFolders).map((f) => f.path)
      if (!existing.includes(from)) return err(404, 'Папка не найдена', 'not_found')
      if (from === to) return HttpResponse.json({ path: to, moved: 0 })
      if (within(to, from)) return err(400, 'Нельзя перенести папку внутрь неё самой', 'folder_into_itself')
      if (existing.includes(to)) return err(409, `Папка «${to}» уже есть`, 'folder_exists')
      const moved = moveSubtree(from, to)
      if (!db.knowledgeFolders.includes(to)) db.knowledgeFolders.push(to)
      logAudit('knowledge_folder_moved', from, { to, notes: moved })
      return HttpResponse.json({ path: to, moved })
    }),
  ),
  http.delete(
    A('/knowledge/folders'),
    guard(({ request }: { request: Request }) => {
      const path = normFolder(new URL(request.url).searchParams.get('path') ?? '')
      if (!folderList(db.knowledge, db.knowledgeFolders).some((f) => f.path === path))
        return err(404, 'Папка не найдена', 'not_found')
      const parent = parentOf(path)
      db.knowledgeFolders = db.knowledgeFolders.filter((f) => f !== path)
      const moved = moveSubtree(path, parent)
      logAudit('knowledge_folder_deleted', path, { to: parent, notes: moved })
      return HttpResponse.json({ path: parent, moved })
    }),
  ),
  http.get(
    A('/knowledge/:id'),
    guard(({ params }: { params: Record<string, string> }) => {
      const d = wikiDetail(db.knowledge, String(params.id))
      return d ? HttpResponse.json(d) : err(404, 'Не найдено', 'not_found')
    }),
  ),
  http.patch(
    A('/knowledge/:id'),
    guard(async ({ params, request }: { params: Record<string, string>; request: Request }) => {
      const item = db.knowledge.find((k) => k.id === params.id)
      if (!item) return err(404, 'Не найдено', 'not_found')
      const body = (await request.json()) as { title?: string; text?: string; folder?: string }
      if (item.source === 'builtin' && (body.title !== undefined || body.text !== undefined))
        return err(409, 'Встроенный материал можно только перенести в другую папку', 'builtin_protected')
      if (body.title !== undefined && body.title !== item.title) {
        if ((body as { update_links?: boolean }).update_links !== false) {
          const me = wikiDetail(db.knowledge, item.id)
          for (const b of me?.backlinks ?? []) {
            const other = db.knowledge.find((k) => k.id === b.id)
            if (other && other.source !== 'builtin') {
              other._content = renameLinks(other._content, item.title, body.title)
              other.updated_at = new Date().toISOString()
            }
          }
        }
        item.title = body.title
      }
      if (body.folder !== undefined) item.folder = body.folder.split('/').map((p) => p.trim()).filter(Boolean).join('/')
      if (body.text !== undefined) {
        item._content = body.text
        item.chars = body.text.length
        item.status = 'indexing'
        item._readyAt = Date.now() + 1500
      }
      item.updated_at = new Date().toISOString()
      logAudit('knowledge.update', item.id, { title: item.title })
      return HttpResponse.json(strip(item))
    }),
  ),
  http.delete(
    A('/knowledge/:id'),
    guard(({ params }: { params: Record<string, string> }) => {
      const item = db.knowledge.find((k) => k.id === params.id)
      if (!item) return err(404, 'Не найдено', 'not_found')
      if (item.source === 'builtin') return err(409, 'Встроенный материал нельзя удалить', 'conflict')
      db.knowledge = db.knowledge.filter((k) => k.id !== params.id)
      logAudit('knowledge.delete', String(params.id))
      return new HttpResponse(null, { status: 204 })
    }),
  ),

  // ---------------- service
  http.get(A('/health'), () =>
    HttpResponse.json({
      status: 'degraded',
      version: 'mock',
      checks: { postgres: 'ok', redis: 'ok', qdrant: 'ok', s3: 'ok', embedder: 'error: демо-режим, эмбеддер не запущен' },
      limits: { max_upload_mb: db.settings.max_upload_mb },
    }),
  ),
  http.get(
    A('/usage'),
    guard(({ request }) => {
      // как бэкенд: from/to — даты YYYY-MM-DD (UTC, включительно), по умолчанию последние 30 дней
      const url = new URL(request.url)
      const day = 86_400_000
      const to = url.searchParams.get('to') ?? new Date().toISOString().slice(0, 10)
      const from = url.searchParams.get('from') ?? new Date(Date.parse(to) - 29 * day).toISOString().slice(0, 10)
      const days = Math.max(0, Math.min(366, Math.round((Date.parse(to) - Date.parse(from)) / day) + 1))
      type K = 'runs' | 'llm_calls' | 'prompt_tokens' | 'completion_tokens' | 'cost_usd' | 'duration_s'
      const keys: K[] = ['runs', 'llm_calls', 'prompt_tokens', 'completion_tokens', 'cost_usd', 'duration_s']
      const by_day = Array.from({ length: days }, (_, i) => {
        const t = Date.parse(from) + i * day
        const runs = Math.round(1 + 4 * Math.abs(Math.sin(Math.floor(t / day) * 1.7)))
        const calls = runs * 7
        return {
          date: new Date(t).toISOString().slice(0, 10),
          runs,
          llm_calls: calls,
          prompt_tokens: calls * 3400,
          completion_tokens: calls * 640,
          cost_usd: Math.round(calls * 0.0023 * 1000) / 1000,
          duration_s: runs * 41.5,
        }
      })
      const round = (n: number) => Math.round(n * 1000) / 1000
      const totals = Object.fromEntries(keys.map((k) => [k, round(by_day.reduce((s, d) => s + d[k], 0))])) as Record<K, number>
      const share = [
        { provider: 'gemini', model: 'gemini-2.5-flash', k: 0.7 },
        { provider: 'openai', model: 'gpt-4.1-mini', k: 0.2 },
        { provider: 'openai_compatible', model: 'qwen2.5:7b-instruct', k: 0.1 },
      ]
      const by_provider = share.map(({ provider, model, k }) => ({
        provider,
        model,
        ...(Object.fromEntries(keys.map((key) => [key, round(totals[key] * k)])) as Record<K, number>),
        ...(provider === 'openai_compatible' ? { cost_usd: 0 } : {}),
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
      const action = url.searchParams.get('action')
      const q = url.searchParams.get('q')?.trim().toLowerCase()
      const items = db.audit.filter(
        (a) =>
          (!action || a.action === action) &&
          (!q || [a.actor, a.action, a.target ?? '', JSON.stringify(a.details ?? {})].some((v) => v.toLowerCase().includes(q))),
      )
      const actions = [...new Set(db.audit.map((a) => a.action))].sort()
      return HttpResponse.json({ items: items.slice(offset, offset + limit) as unknown as JsonBodyType, total: items.length, actions })
    }),
  ),
]

/** Перенос поддерева папок: заметки и явные папки внутри «from» получают префикс «to». */
function moveSubtree(from: string, to: string): number {
  let moved = 0
  const now = new Date().toISOString()
  db.knowledge.forEach((k) => {
    if (within(k.folder ?? '', from)) {
      k.folder = movePath(k.folder ?? '', from, to)
      k.updated_at = now
      moved++
    }
  })
  db.knowledgeFolders = [...new Set(db.knowledgeFolders.map((f) => movePath(f, from, to)).filter(Boolean))]
  return moved
}

function strip<T extends object>(o: T): T {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o)) if (!k.startsWith('_')) out[k] = v
  return out as T
}
