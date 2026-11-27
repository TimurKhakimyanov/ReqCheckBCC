import type { ProgressEvent, RunStage } from '@/api/types'
import { isTerminal } from '@/api/types'

/**
 * Этапы пайплайна как «агенты» конвейера. Порядок — как в PIPELINE_STAGES без queued/done.
 * llm — ходит ли агент в модель (показываем модель прогона) или работает кодом.
 * Названия, роли, вход/выход — в локалях: agents.<stage>.*
 */
export interface AgentMeta {
  stage: RunStage
  code: string
  short: string
  llm: boolean
}

export const AGENTS: AgentMeta[] = [
  { stage: 'parsing', code: 'A-01', short: 'PARSE', llm: false },
  { stage: 'segmenting', code: 'A-02', short: 'SPLIT', llm: true },
  { stage: 'rule_checks', code: 'A-03', short: 'RULES', llm: false },
  { stage: 'checking_requirements', code: 'A-04', short: 'REVIEW', llm: true },
  { stage: 'checking_set', code: 'A-05', short: 'SET', llm: true },
  { stage: 'verifying', code: 'A-06', short: 'VERIFY', llm: true },
  { stage: 'rendering', code: 'A-07', short: 'REPORT', llm: true },
]

export type AgentState = 'pending' | 'active' | 'done' | 'failed'

export interface AgentRuntime {
  state: AgentState
  /** Первое событие этапа */
  startedAt: number | null
  /** Начало следующего этапа (или терминального события) */
  finishedAt: number | null
  current: number | null
  total: number | null
  /** События этого этапа без повторов, старые сверху */
  events: ProgressEvent[]
}

const ts = (e: ProgressEvent) => {
  const n = Date.parse(e.ts)
  return Number.isNaN(n) ? null : n
}

/**
 * Состояние каждого агента по потоку событий.
 * reachedIdx — индекс текущего (или последнего достигнутого при сбое) агента; -1 — ещё не начали
 * или стадия сбоя неизвестна (прогон открыт из истории): тогда ни один агент не помечается упавшим.
 */
export function agentRuntimes(events: ProgressEvent[], reachedIdx: number, finished: boolean, failed: boolean): AgentRuntime[] {
  const byStage = new Map<RunStage, ProgressEvent[]>()
  events.forEach((e) => {
    const list = byStage.get(e.stage) ?? []
    const prev = list.at(-1)
    if (!prev || prev.message !== e.message || prev.current !== e.current) list.push(e)
    byStage.set(e.stage, list)
  })
  return AGENTS.map((a, i) => {
    const own = byStage.get(a.stage) ?? []
    const first = own[0]
    // конец этапа — первое событие любого более позднего этапа
    const later = events.find((e) => {
      const j = AGENTS.findIndex((x) => x.stage === e.stage)
      return j > i || isTerminal(e.stage)
    })
    const withTotal = [...own].reverse().find((e) => e.total)
    let state: AgentState = 'pending'
    if (finished || i < reachedIdx) state = 'done'
    else if (i === reachedIdx) state = failed ? 'failed' : 'active'
    return {
      state,
      startedAt: first ? ts(first) : null,
      finishedAt: state === 'done' && later ? ts(later) : null,
      current: withTotal?.current ?? null,
      total: withTotal?.total ?? null,
      events: own,
    }
  })
}

/** Требований в минуту по событиям проверки требований (current растёт со временем). */
export function throughputPerMin(events: ProgressEvent[]): number | null {
  const pts = events
    .filter((e) => e.stage === 'checking_requirements' && e.current != null)
    .map((e) => ({ c: e.current as number, t: Date.parse(e.ts) }))
    .filter((p) => !Number.isNaN(p.t))
  if (pts.length < 2) return null
  const a = pts[0]
  const b = pts.at(-1)!
  const dt = (b.t - a.t) / 60000
  if (dt <= 0 || b.c <= a.c) return null
  return (b.c - a.c) / dt
}

export function formatClock(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}
