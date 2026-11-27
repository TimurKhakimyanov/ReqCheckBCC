import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useRunEvents } from './useRunEvents'

class FakeEventSource {
  static instances: FakeEventSource[] = []
  static CLOSED = 2
  url: string
  readyState = 0
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  listeners: Record<string, ((e: MessageEvent) => void)[]> = {}
  closed = false
  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    ;(this.listeners[type] ??= []).push(fn)
  }
  close() {
    this.closed = true
    this.readyState = 2
  }
  emit(type: string, data: unknown) {
    this.listeners[type]?.forEach((fn) => fn(new MessageEvent(type, { data: JSON.stringify(data) })))
  }
}

describe('useRunEvents', () => {
  afterEach(() => {
    FakeEventSource.instances = []
    vi.unstubAllGlobals()
  })

  it('collects progress events and closes the stream on a terminal stage', () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    const onTerminal = vi.fn()
    const { result } = renderHook(() => useRunEvents('r1', true, onTerminal))
    const es = FakeEventSource.instances[0]
    expect(es.url).toBe('/api/runs/r1/events')
    act(() => es.onopen?.())
    expect(result.current.state).toBe('open')
    act(() => es.emit('progress', { stage: 'checking_requirements', progress: 0.5, message: 'R-003', current: 3, total: 6, ts: '' }))
    expect(result.current.latest?.current).toBe(3)
    act(() => es.emit('progress', { stage: 'done', progress: 1, message: '', ts: '' }))
    expect(es.closed).toBe(true)
    expect(result.current.state).toBe('closed')
    expect(onTerminal).toHaveBeenCalledWith(expect.objectContaining({ stage: 'done' }))
    expect(result.current.events).toHaveLength(2)
  })

  it('does not connect when disabled', () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    renderHook(() => useRunEvents('r1', false))
    expect(FakeEventSource.instances).toHaveLength(0)
  })
})
