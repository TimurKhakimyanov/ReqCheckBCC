import { describe, expect, it } from 'vitest'
import type { Run, RunLogEntry, RunLogs } from '@/api/types'
import { defaultOpen, groupRunLogs, matchesFilter, totals } from './logTree'

const T0 = Date.parse('2026-11-27T10:00:00Z')
let seq = 0
const e = (sec: number, stage: RunLogEntry['stage'], over: Partial<RunLogEntry> = {}): RunLogEntry => ({
  id: ++seq,
  ts: new Date(T0 + sec * 1000).toISOString(),
  level: 'info',
  source: 'progress',
  stage,
  message: `m${seq}`,
  data: {},
  ...over,
})
const run = (status: Run['status']): Run => ({
  id: 'r1',
  document_id: 'd1',
  document_name: 'doc.md',
  status,
  stage: status,
  progress: 0.5,
  provider: 'gemini',
  model: 'gemini-2.5-flash',
  options: {},
  created_at: new Date(T0).toISOString(),
  started_at: new Date(T0).toISOString(),
})
const logs = (status: Run['status'], items: RunLogEntry[]): RunLogs => ({ run: run(status), items, audit: [], truncated: false })

describe('groupRunLogs', () => {
  it('splits entries into start → agents → finish with durations and LLM stats', () => {
    const groups = groupRunLogs(
      logs('done', [
        e(0, 'queued', { source: 'worker' }),
        e(1, 'parsing'),
        e(3, 'segmenting'),
        e(4, 'segmenting', { source: 'llm', data: { kind: 'llm_call', latency_ms: 900, prompt_tokens: 100, completion_tokens: 20 } }),
        e(10, 'checking_requirements', { level: 'warning', source: 'core' }),
        e(20, 'done'),
      ]),
    )
    expect(groups.map((g) => g.key)).toEqual([
      'start', 'parsing', 'segmenting', 'rule_checks', 'checking_requirements', 'checking_set', 'verifying', 'rendering', 'finish',
    ])
    const seg = groups.find((g) => g.key === 'segmenting')!
    expect(seg.entries).toHaveLength(2)
    expect([seg.llmCalls, seg.llmMs, seg.tokensIn, seg.tokensOut]).toEqual([1, 900, 100, 20])
    expect(seg.endedAt! - seg.startedAt!).toBe(7000) // до начала следующего агента
    expect(groups.find((g) => g.key === 'rule_checks')!.state).toBe('skipped')
    expect(groups.find((g) => g.key === 'checking_set')!.state).toBe('pending')
    expect(groups.find((g) => g.key === 'checking_requirements')!.state).toBe('done')
    expect(totals(groups)).toMatchObject({ entries: 6, llmCalls: 1, warnings: 1, errors: 0 })
    expect([...defaultOpen(groups)]).toEqual(['checking_requirements'])
  })

  it('marks the last agent failed for a failed run and active for a live one', () => {
    const items = [e(0, 'parsing'), e(2, 'checking_requirements', { level: 'error' }), e(3, 'failed', { level: 'error' })]
    const failed = groupRunLogs(logs('failed', items))
    expect(failed.find((g) => g.key === 'checking_requirements')!.state).toBe('failed')
    expect(failed.find((g) => g.key === 'finish')!.state).toBe('failed')
    const live = groupRunLogs(logs('checking_requirements', items.slice(0, 2)))
    expect(live.find((g) => g.key === 'checking_requirements')!.state).toBe('active')
    expect(defaultOpen(live).has('checking_requirements')).toBe(true)
  })
})

describe('matchesFilter', () => {
  it('filters by kind and text (message and data)', () => {
    const llm = e(0, 'segmenting', { source: 'llm', message: 'LLM ok', data: { schema: 'SegmentResult' } })
    const warn = e(0, 'segmenting', { level: 'warning', message: 'Шаг не выполнен' })
    expect(matchesFilter(llm, 'llm', '')).toBe(true)
    expect(matchesFilter(warn, 'llm', '')).toBe(false)
    expect(matchesFilter(warn, 'problems', '')).toBe(true)
    expect(matchesFilter(llm, 'all', 'segmentresult')).toBe(true)
    expect(matchesFilter(warn, 'all', 'segment')).toBe(false)
  })
})
