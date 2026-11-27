// Поведение, уточнённое бэкендом (docs/contract-changes/backend.md в ветке бэкенда): клиент и моки должны его понимать.
import { describe, expect, it } from 'vitest'
import { db } from '@/mocks/data'
import { downloadFile, filenameFromDisposition } from '@/shared/format'
import { api, ApiError, streamChat } from './client'
import { readSSE } from './sse'

describe('backend contract details', () => {
  it('prefers RFC 5987 filename* over the ASCII fallback', () => {
    expect(filenameFromDisposition(`attachment; filename="____.md"; filename*=UTF-8''%D0%BE%D1%82%D1%87%D1%91%D1%82.md`)).toBe('отчёт.md')
    expect(filenameFromDisposition('attachment; filename="report.json"')).toBe('report.json')
    expect(filenameFromDisposition(null)).toBeNull()
  })

  it('surfaces 501 render_unavailable from report exports', async () => {
    const err = await downloadFile(api.reportExportUrl('run-sample', 'pdf'), 'x.pdf').catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 501, code: 'render_unavailable' })
  })

  it('keeps the 422 errors array', async () => {
    const err = await api.updateMe({ password: { current: 'admin', new: 'short' } }).catch((e) => e)
    expect(err).toMatchObject({ status: 422, code: 'validation_error' })
    expect(err.errors[0].loc).toEqual(['body', 'password', 'new'])
  })

  it('raises on event: error in the chat stream after partial tokens', async () => {
    const tokens: string[] = []
    const err = await streamChat('run-sample', { message: 'сломай ответ' }, { onToken: (t) => tokens.push(t), onDone: () => {} }).catch(
      (e) => e,
    )
    expect(tokens.length).toBeGreaterThan(0)
    expect(err).toMatchObject({ code: 'chat_failed' })
  })

  it('models are always 200 with an optional error; provider test returns ok:false', async () => {
    const models = await api.models('anthropic')
    expect(models.models.length).toBeGreaterThan(0)
    expect(models.error).toBeTruthy()
    expect((await api.models('gemini')).error).toBeUndefined()
    expect(await api.testProvider('anthropic')).toMatchObject({ ok: false })
  })

  it('refuses to delete built-in knowledge with 409 and exposes KnowledgeItem.error', async () => {
    await expect(api.deleteKnowledge('kb-builtin')).rejects.toMatchObject({ status: 409 })
    const items = await api.knowledge()
    expect(items.find((k) => k.status === 'failed')?.error).toBeTruthy()
  })

  it('health reports degraded status and the upload limit; usage rows use date', async () => {
    const h = await api.health()
    expect(h.status).toBe('degraded')
    expect(h.limits?.max_upload_mb).toBe(25)
    const u = await api.usage({ from: '2026-11-01', to: '2026-11-07' })
    expect(u.by_day.map((d) => d.date)).toEqual(['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07'])
    expect(u.totals.runs).toBeGreaterThan(0)
  })

  it('run defaults provider/model when omitted and exposes Run.message', async () => {
    const run = await api.createRun({ document_id: 'doc-sample' })
    expect(run.provider).toBe('gemini')
    expect(run.model).toBe(db.providers.gemini.default_model)
    expect(typeof run.message).toBe('string')
  })

  it('progress SSE starts with retry and the parser skips it', async () => {
    const res = await fetch('/api/runs/run-sample/events')
    const events = []
    for await (const m of readSSE(res.body!)) events.push(m)
    expect(events).toHaveLength(1)
    expect(events[0].event).toBe('progress')
    expect(JSON.parse(events[0].data).stage).toBe('done')
  })
})
