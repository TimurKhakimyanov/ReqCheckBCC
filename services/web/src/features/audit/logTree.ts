// Журнал прогона → дерево: запуск воркера → агенты A-01…A-07 → завершение. Чистые функции (тесты в logTree.test.ts).
import type { RunLogEntry, RunLogs, RunStage } from '@/api/types'
import { isTerminal } from '@/api/types'
import { AGENTS, type AgentMeta } from '@/features/runs/agents'

export type GroupState = 'done' | 'active' | 'failed' | 'pending' | 'skipped'

export interface LogGroup {
  key: string
  kind: 'start' | 'agent' | 'finish'
  stage?: RunStage
  meta?: AgentMeta
  entries: RunLogEntry[]
  startedAt: number | null
  endedAt: number | null
  llmCalls: number
  llmMs: number
  tokensIn: number
  tokensOut: number
  warnings: number
  errors: number
  state: GroupState
}

export type LogFilter = 'all' | 'llm' | 'problems'

const FINISH: RunStage[] = ['done', 'failed', 'cancelled']
const ms = (iso: string) => {
  const n = Date.parse(iso)
  return Number.isNaN(n) ? null : n
}
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export const isLlmCall = (e: RunLogEntry) => e.source === 'llm' && e.data?.kind === 'llm_call'
export const isProblem = (e: RunLogEntry) => e.level === 'warning' || e.level === 'error' || e.level === 'critical'

export function matchesFilter(e: RunLogEntry, filter: LogFilter, q: string): boolean {
  if (filter === 'llm' && e.source !== 'llm') return false
  if (filter === 'problems' && !isProblem(e)) return false
  const s = q.trim().toLowerCase()
  if (!s) return true
  return e.message.toLowerCase().includes(s) || JSON.stringify(e.data ?? {}).toLowerCase().includes(s)
}

function groupKey(stage: RunStage | null): string {
  if (!stage || stage === 'queued') return 'start'
  if (FINISH.includes(stage)) return 'finish'
  return stage
}

export function groupRunLogs(logs: RunLogs): LogGroup[] {
  const buckets = new Map<string, RunLogEntry[]>()
  for (const e of logs.items) {
    const k = groupKey(e.stage)
    const list = buckets.get(k) ?? []
    list.push(e)
    buckets.set(k, list)
  }
  const skeleton: Pick<LogGroup, 'key' | 'kind' | 'stage' | 'meta'>[] = [
    { key: 'start', kind: 'start' },
    ...AGENTS.map((a) => ({ key: a.stage, kind: 'agent' as const, stage: a.stage, meta: a })),
    { key: 'finish', kind: 'finish' },
  ]
  const groups: LogGroup[] = skeleton.map((g) => {
    const entries = buckets.get(g.key) ?? []
    const llm = entries.filter(isLlmCall)
    return {
      ...g,
      entries,
      startedAt: entries.length ? ms(entries[0].ts) : null,
      endedAt: entries.length ? ms(entries[entries.length - 1].ts) : null,
      llmCalls: llm.length,
      llmMs: llm.reduce((s, e) => s + num(e.data.latency_ms), 0),
      tokensIn: llm.reduce((s, e) => s + num(e.data.prompt_tokens), 0),
      tokensOut: llm.reduce((s, e) => s + num(e.data.completion_tokens), 0),
      warnings: entries.filter((e) => e.level === 'warning').length,
      errors: entries.filter((e) => e.level === 'error' || e.level === 'critical').length,
      state: 'pending',
    }
  })

  // конец группы — начало следующей непустой (агенты идут по очереди)
  for (let i = 0; i < groups.length; i++) {
    if (groups[i].startedAt == null) continue
    const next = groups.slice(i + 1).find((g) => g.startedAt != null)
    if (next?.startedAt != null) groups[i].endedAt = Math.max(groups[i].endedAt ?? 0, next.startedAt)
  }

  const status = logs.run.status
  const terminal = isTerminal(status)
  const agents = groups.filter((g) => g.kind === 'agent')
  const lastIdx = agents.reduce((acc, g, i) => (g.entries.length ? i : acc), -1)
  agents.forEach((g, i) => {
    if (g.entries.length) {
      if (i === lastIdx && status === 'failed') g.state = 'failed'
      else if (i === lastIdx && !terminal) g.state = 'active'
      else g.state = 'done'
    } else g.state = status === 'done' && i < lastIdx ? 'skipped' : 'pending'
  })
  for (const g of groups) {
    if (g.kind === 'agent') continue
    g.state = g.entries.length ? (g.kind === 'finish' && status === 'failed' ? 'failed' : 'done') : 'pending'
  }
  return groups
}

/** Группы, раскрытые по умолчанию: со сбоем, с предупреждениями/ошибками, текущий агент. */
export function defaultOpen(groups: LogGroup[]): Set<string> {
  return new Set(groups.filter((g) => g.state === 'failed' || g.state === 'active' || g.errors > 0 || g.warnings > 0).map((g) => g.key))
}

/** Итог по прогону для шапки. */
export function totals(groups: LogGroup[]) {
  return groups.reduce(
    (s, g) => ({
      entries: s.entries + g.entries.length,
      llmCalls: s.llmCalls + g.llmCalls,
      llmMs: s.llmMs + g.llmMs,
      warnings: s.warnings + g.warnings,
      errors: s.errors + g.errors,
    }),
    { entries: 0, llmCalls: 0, llmMs: 0, warnings: 0, errors: 0 },
  )
}
