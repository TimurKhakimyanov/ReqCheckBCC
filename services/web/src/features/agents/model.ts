// Архитектура агентов ReqCheck — как в packages/core/req_core (pipeline.py, prompts.py, rules.py, chat.py).
// Тексты (название, роль, вход, выход, как устроено) — в локалях: agentsPage.items.<id>.*
import type { Criterion, RunStage } from '@/api/types'
import { REQUIREMENT_CRITERIA } from '@/shared/criteria'

/** llm — ходит в модель; code — детерминированный код; data — источник или результат, не агент. */
export type AgentKind = 'llm' | 'code' | 'data'

export type LaneId = 'input' | 'parsing' | 'segmenting' | 'rule_checks' | 'checking_requirements' | 'checking_set' | 'quotes' | 'verifying' | 'rendering' | 'chat'

export interface Lane {
  id: LaneId
  /** Стадия прогона (ProgressEvent.stage), если полоса совпадает с ней — как на экране прогона */
  stage?: RunStage
  code?: string
}

export const LANES: Lane[] = [
  { id: 'input' },
  { id: 'parsing', stage: 'parsing', code: 'A-01' },
  { id: 'segmenting', stage: 'segmenting', code: 'A-02' },
  { id: 'rule_checks', stage: 'rule_checks', code: 'A-03' },
  { id: 'checking_requirements', stage: 'checking_requirements', code: 'A-04' },
  { id: 'checking_set', stage: 'checking_set', code: 'A-05' },
  { id: 'quotes' },
  { id: 'verifying', stage: 'verifying', code: 'A-06' },
  { id: 'rendering', stage: 'rendering', code: 'A-07' },
  { id: 'chat' },
]

export interface AgentDef {
  id: string
  lane: LaneId
  kind: AgentKind
  /** Чьи результаты получает (база знаний для LLM-агентов добавляется сама — она в системном промпте) */
  from: string[]
  /** Критерии ISO/IEC/IEEE 29148, за которые отвечает */
  criteria: Criterion[]
  /** Где в коде */
  fn: string
  /** Запросы идут параллельно (ValidationOptions.concurrency) */
  parallel?: boolean
  /** Рецензент набора (prompts.REVIEW_ROLES) */
  reviewer?: boolean
}

const FINDERS = ['rules', 'inspector', 'logic', 'contract', 'analyst', 'qa', 'architect', 'security']

export const AGENTS: AgentDef[] = [
  { id: 'document', lane: 'input', kind: 'data', from: [], criteria: [], fn: 'POST /api/documents → S3' },
  { id: 'knowledge', lane: 'input', kind: 'data', from: [], criteria: [], fn: 'worker/tasks.py · knowledge_snippets → Qdrant' },
  { id: 'parser', lane: 'parsing', kind: 'code', from: ['document'], criteria: [], fn: 'parsing.py · parse_document' },
  { id: 'segmenter', lane: 'segmenting', kind: 'llm', from: ['parser'], criteria: [], fn: 'pipeline.py · segment' },
  {
    id: 'rules', lane: 'rule_checks', kind: 'code', from: ['segmenter'], fn: 'rules.py · rule_findings',
    criteria: ['unambiguous', 'complete', 'singular', 'set_complete', 'set_validatable', 'set_modifiable'],
  },
  {
    id: 'inspector', lane: 'checking_requirements', kind: 'llm', from: ['segmenter', 'rules'], parallel: true,
    criteria: REQUIREMENT_CRITERIA, fn: 'pipeline.py · check_requirements',
  },
  ...(
    [
      ['logic', ['set_consistent']],
      ['contract', ['set_consistent']],
      ['analyst', ['set_complete', 'set_comprehensible', 'set_ranked', 'set_modifiable']],
      ['qa', ['set_validatable']],
      ['architect', ['set_traceable', 'set_feasible']],
      ['security', ['set_complete', 'set_feasible']],
    ] as [string, Criterion[]][]
  ).map(([id, criteria]): AgentDef => ({
    id, lane: 'checking_set', kind: 'llm', from: ['segmenter', 'rules', 'inspector'], criteria, parallel: true, reviewer: true,
    fn: `prompts.py · REVIEW_ROLES["${id}"]`,
  })),
  { id: 'quotes', lane: 'quotes', kind: 'code', from: FINDERS, criteria: [], fn: 'pipeline.py · resolve_quotes, dedupe' },
  { id: 'verifier', lane: 'verifying', kind: 'llm', from: ['quotes'], criteria: [], parallel: true, fn: 'pipeline.py · verify' },
  { id: 'merger', lane: 'verifying', kind: 'llm', from: ['verifier'], criteria: [], fn: 'pipeline.py · llm_dedup' },
  { id: 'checklist', lane: 'rendering', kind: 'llm', from: ['merger'], criteria: [], fn: 'pipeline.py · _checklist' },
  { id: 'questions', lane: 'rendering', kind: 'llm', from: ['merger'], criteria: [], fn: 'pipeline.py · clarifying_questions' },
  { id: 'conclusion', lane: 'rendering', kind: 'llm', from: ['merger'], criteria: [], fn: 'pipeline.py · _conclusion' },
  { id: 'report', lane: 'rendering', kind: 'data', from: ['merger', 'checklist', 'questions', 'conclusion'], criteria: [], fn: 'render.py · render_report' },
  { id: 'chat', lane: 'chat', kind: 'llm', from: ['report'], criteria: [], fn: 'chat.py · answer_stream' },
]

export const byId = (id: string) => AGENTS.find((a) => a.id === id)

/** Входы агента: явные и база знаний — она попадает в системный промпт каждого LLM-агента. */
export const inputsOf = (a: AgentDef) => (a.kind === 'llm' ? [...a.from, 'knowledge'] : a.from)

/** Кто получает результат агента */
export const outputsOf = (id: string) => AGENTS.filter((a) => inputsOf(a).includes(id)).map((a) => a.id)

/** Столбцы матрицы критериев: кто ищет дефекты */
export const FINDER_IDS = FINDERS

/** Этапы жизни дефекта — от кандидата до номера D-xxx в отчёте (agentsPage.flow.<id>); reviewers — все рецензенты набора */
export const FLOW: { id: string; agents: string[] }[] = [
  { id: 'found', agents: ['rules', 'inspector', 'reviewers'] },
  { id: 'quote', agents: ['quotes'] },
  { id: 'dedupe', agents: ['quotes'] },
  { id: 'verify', agents: ['verifier'] },
  { id: 'merge', agents: ['merger'] },
  { id: 'number', agents: ['report'] },
  { id: 'use', agents: ['checklist', 'questions', 'conclusion', 'chat'] },
]

export const PRINCIPLES = ['known', 'schema', 'quotes', 'refute', 'parallel', 'failures', 'progress', 'kb'] as const
