// Запасной режим моков без Service Worker (встроенные браузеры, file-proxy, запрет SW политикой).
// Те же MSW-обработчики вызываются прямо в странице: подменяются fetch и EventSource.
import { getResponse } from 'msw'
import { readSSE } from '@/api/sse'
import { handlers } from './handlers'

declare global {
  interface Window {
    __REQCHECK_INPAGE_MOCKS__?: boolean
  }
}

const isApi = (url: URL) => url.origin === location.origin && url.pathname.startsWith('/api/')

class MockEventSource extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2
  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSED = 2
  readyState = 0
  url: string
  withCredentials: boolean
  onopen: ((e: Event) => void) | null = null
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: Event) => void) | null = null
  private ctrl = new AbortController()

  constructor(url: string | URL, init?: EventSourceInit) {
    super()
    this.url = new URL(url, location.href).href
    this.withCredentials = !!init?.withCredentials
    void this.run()
  }

  private fail() {
    if (this.readyState === 2) return
    this.readyState = 2
    const e = new Event('error')
    this.onerror?.(e)
    this.dispatchEvent(e)
  }

  private async run() {
    try {
      const res = await window.fetch(this.url, { headers: { Accept: 'text/event-stream' }, signal: this.ctrl.signal })
      if (!res.ok || !res.body) return this.fail()
      this.readyState = 1
      const open = new Event('open')
      this.onopen?.(open)
      this.dispatchEvent(open)
      for await (const m of readSSE(res.body, this.ctrl.signal)) {
        if (this.readyState === 2) return
        const ev = new MessageEvent(m.event, { data: m.data, lastEventId: m.id ?? '' })
        if (m.event === 'message') this.onmessage?.(ev)
        this.dispatchEvent(ev)
      }
      this.fail()
    } catch {
      this.fail()
    }
  }

  close() {
    this.readyState = 2
    this.ctrl.abort()
  }
}

export function installInPageMocks() {
  const realFetch = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init)
    if (!isApi(new URL(req.url))) return realFetch(input, init)
    const res = await getResponse(handlers, req)
    return (
      res ??
      new Response(JSON.stringify({ detail: `No mock for ${req.method} ${req.url}`, code: 'no_mock' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })
    )
  }
  window.EventSource = MockEventSource as unknown as typeof EventSource
  window.__REQCHECK_INPAGE_MOCKS__ = true
}
