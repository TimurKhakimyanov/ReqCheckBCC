import { useEffect, useRef, useState } from 'react'
import { api } from '@/api/client'
import type { ProgressEvent } from '@/api/types'
import { isTerminal } from '@/api/types'

export type StreamState = 'connecting' | 'open' | 'reconnecting' | 'closed'

/**
 * Прогресс прогона по SSE (GET /runs/{id}/events, event: progress). Сервер сначала отдаёт текущее
 * состояние, затем изменения; после стадии done/failed/cancelled поток закрываем сами, иначе
 * EventSource переподключится.
 */
export function useRunEvents(runId: string, enabled: boolean, onTerminal?: (ev: ProgressEvent) => void) {
  const [events, setEvents] = useState<ProgressEvent[]>([])
  const [state, setState] = useState<StreamState>('connecting')
  const cb = useRef(onTerminal)
  cb.current = onTerminal

  useEffect(() => {
    if (!enabled) return
    setEvents([])
    setState('connecting')
    const es = new EventSource(api.runEventsUrl(runId), { withCredentials: true })
    es.onopen = () => setState('open')
    es.addEventListener('progress', (e) => {
      let ev: ProgressEvent
      try {
        ev = JSON.parse((e as MessageEvent<string>).data)
      } catch {
        return
      }
      setEvents((xs) => [...xs, ev])
      if (isTerminal(ev.stage)) {
        es.close()
        setState('closed')
        cb.current?.(ev)
      }
    })
    es.onerror = () => {
      // EventSource сам переподключается; CLOSED — сервер отказал (например, 401/404)
      setState(es.readyState === EventSource.CLOSED ? 'closed' : 'reconnecting')
    }
    return () => es.close()
  }, [runId, enabled])

  return { events, latest: events.at(-1), state }
}
