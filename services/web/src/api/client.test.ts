import { describe, expect, it, vi } from 'vitest'
import { db, setSession } from '@/mocks/data'
import { api, ApiError, onUnauthorized, streamChat } from './client'

describe('API client', () => {
  it('streams a chat answer token by token over POST + SSE', async () => {
    const tokens: string[] = []
    const onDone = vi.fn()
    await streamChat('run-sample', { message: 'Что исправить первым?' }, { onToken: (t) => tokens.push(t), onDone })
    expect(tokens.length).toBeGreaterThan(5)
    expect(onDone).toHaveBeenCalledOnce()
    const final = onDone.mock.calls[0][0]
    expect(final.role).toBe('assistant')
    expect(tokens.join('')).toBe(final.content)
    expect(db.chats['run-sample']).toHaveLength(2)
  })

  it('turns error bodies into ApiError and reports 401', async () => {
    const handler = vi.fn()
    onUnauthorized(handler)
    setSession(false)
    await expect(api.documents()).rejects.toMatchObject({ status: 401, code: 'not_authenticated' })
    expect(handler).toHaveBeenCalled()
    onUnauthorized(null)
    setSession(true)
    const err = await api.run('missing').catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(404)
  })

  it('rejects a run when the provider has no key', async () => {
    await expect(api.createRun({ document_id: 'doc-sample', provider: 'anthropic', model: 'x' })).rejects.toMatchObject({
      code: 'provider_not_configured',
    })
  })
})
