// Архитектура агентов Zoe — как в packages/core/req_core/agent (методика bbc-agent): agent/run.py, agents/*, guard.py.
// Тексты (название, роль, вход, выход, как устроено) — в локалях: agentsPage.items.<id>.*
import type { Criterion, RunStage } from '@/api/types'
import { REQUIREMENT_CRITERIA } from '@/shared/criteria'

/** llm — ходит в модель; code — детерминированный код; data — источник или результат, не агент. */
export type AgentKind = 'llm' | 'code' | 'data'

export type LaneId =
  | 'input'
  | 'parsing'
  | 'rule_checks'
  | 'segmenting'
  | 'planning'
  | 'checking_requirements'
  | 'checking_set'
  | 'quotes'
  | 'verifying'
  | 'clarify'
  | 'verdict'
  | 'rendering'
  | 'chat'

export interface Lane {
  id: LaneId
  /** Стадия прогона (ProgressEvent.stage), если полоса совпадает с ней — как на экране прогона */
  stage?: RunStage
  code?: string
}

// Порядок этапов — как в agent/run.py: чтение → правила → нарезка → планировщик и воркеры → верификатор →
// вопросы и чек-лист → итог → отчёт. Инспектор и рецензенты — воркеры одного этапа, идут одновременно.
export const LANES: Lane[] = [
  { id: 'input' },
  { id: 'parsing', stage: 'parsing', code: 'A-01' },
  { id: 'rule_checks', stage: 'rule_checks', code: 'A-02' },
  { id: 'segmenting', stage: 'segmenting', code: 'A-03' },
  { id: 'planning', stage: 'checking_requirements', code: 'A-04' },
  { id: 'checking_requirements', stage: 'checking_requirements', code: 'A-05' },
  { id: 'checking_set', stage: 'checking_set', code: 'A-06' },
  { id: 'quotes' },
  { id: 'verifying', stage: 'verifying', code: 'A-07' },
  { id: 'clarify', code: 'A-08' },
  { id: 'verdict', code: 'A-09' },
  { id: 'rendering', code: 'A-10' },
  { id: 'chat' },
]

export interface AgentDef {
  id: string
  lane: LaneId
  kind: AgentKind
  /** Чьи результаты получает */
  from: string[]
  /** Получает фрагменты базы знаний в системном промпте (agent/llm.py · KB_ROLES) */
  kb?: boolean
  /** Критерии ISO/IEC/IEEE 29148, по которым ищет дефекты */
  criteria: Criterion[]
  /** Где в коде (относительно packages/core/req_core) */
  fn: string
  /** Запросы идут параллельно (ValidationOptions.concurrency) */
  parallel?: boolean
  /** Рецензент набора (agents/reviewers.py · PERSPECTIVES) */
  reviewer?: boolean
}

/** Инспектор — 9 критериев п. 5.2.5 (I1–I9); прослеживаемость отдельного требования он не оценивает. */
const INSPECTOR_CRITERIA = REQUIREMENT_CRITERIA.filter((c) => c !== 'traceable')

/** Рецензенты набора: id на странице → ключ роли в ядре и критерии S1–S8. */
const REVIEWERS: [string, string, Criterion[]][] = [
  ['logic', 'consistency', ['set_consistent']],
  ['contract', 'contract', ['set_consistent']],
  ['analyst', 'analyst', ['set_complete', 'set_comprehensible', 'set_ranked', 'set_modifiable']],
  ['qa', 'qa', ['set_validatable']],
  ['architect', 'architect', ['set_traceable', 'set_feasible']],
  ['security', 'security', ['set_complete', 'set_feasible']],
]
const REVIEWER_IDS = REVIEWERS.map(([id]) => id)

export const AGENTS: AgentDef[] = [
  { id: 'document', lane: 'input', kind: 'data', from: [], criteria: [], fn: 'POST /api/documents → S3' },
  { id: 'knowledge', lane: 'input', kind: 'data', from: [], criteria: [], fn: 'worker/tasks.py · knowledge_snippets → Qdrant' },
  { id: 'parser', lane: 'parsing', kind: 'code', from: ['document'], criteria: [], fn: 'parsing.py · parse_document; agent/ingest.py · from_parsed' },
  { id: 'rules', lane: 'rule_checks', kind: 'code', from: ['parser'], criteria: [], fn: 'agent/rules.py · run_rules; rules.py · rule_findings' },
  { id: 'extractor', lane: 'segmenting', kind: 'llm', from: ['parser', 'rules'], criteria: [], fn: 'agent/agents/extractor.py · run' },
  { id: 'planner', lane: 'planning', kind: 'code', from: ['extractor'], criteria: [], fn: 'agent/agents/planner.py · run' },
  {
    id: 'inspector', lane: 'checking_requirements', kind: 'llm', from: ['planner', 'rules'], kb: true, parallel: true,
    criteria: INSPECTOR_CRITERIA, fn: 'agent/agents/inspector.py · inspect',
  },
  ...REVIEWERS.map(([id, key, criteria]): AgentDef => ({
    id, lane: 'checking_set', kind: 'llm', from: ['planner', 'rules'], kb: true, criteria, parallel: true, reviewer: true,
    fn: `agent/agents/reviewers.py · PERSPECTIVES["${key}"]`,
  })),
  { id: 'quotes', lane: 'quotes', kind: 'code', from: ['inspector', ...REVIEWER_IDS], criteria: [], fn: 'agent/guard.py; agent/agents/common.py · record_finding' },
  { id: 'verifier', lane: 'verifying', kind: 'llm', from: ['quotes'], kb: true, criteria: [], parallel: true, fn: 'agent/agents/verifier.py · run' },
  { id: 'merger', lane: 'verifying', kind: 'llm', from: ['verifier'], kb: true, criteria: [], fn: 'agent/agents/verifier.py · _dedup' },
  { id: 'questions', lane: 'clarify', kind: 'llm', from: ['merger'], kb: true, criteria: [], fn: 'agent/agents/clarifier.py · ask' },
  { id: 'checklist', lane: 'clarify', kind: 'llm', from: ['merger'], kb: true, criteria: [], fn: 'agent/agents/finalizer.py · checklist' },
  { id: 'resolver', lane: 'clarify', kind: 'llm', from: ['questions'], kb: true, criteria: [], fn: 'agent/agents/clarifier.py · resolve' },
  { id: 'conclusion', lane: 'verdict', kind: 'llm', from: ['merger', 'questions', 'resolver'], kb: true, criteria: [], fn: 'agent/agents/finalizer.py · verdict' },
  { id: 'report', lane: 'rendering', kind: 'data', from: ['merger', 'checklist', 'questions', 'conclusion'], criteria: [], fn: 'agent/run.py · _report; render.py, pdf.py' },
  { id: 'chat', lane: 'chat', kind: 'llm', from: ['report'], kb: true, criteria: [], fn: 'chat.py · answer_stream' },
]

export const byId = (id: string) => AGENTS.find((a) => a.id === id)

/** Входы агента: явные и база знаний — у агентов, которые получают её фрагменты в системном промпте. */
export const inputsOf = (a: AgentDef) => (a.kb ? [...a.from, 'knowledge'] : a.from)

/** Кто получает результат агента */
export const outputsOf = (id: string) => AGENTS.filter((a) => inputsOf(a).includes(id)).map((a) => a.id)

/** Столбцы матрицы критериев: кто ищет дефекты (правила дают только подсказки) */
export const FINDER_IDS = ['inspector', ...REVIEWER_IDS]

/** Этапы жизни дефекта — от подсказки до номера D-xxx в отчёте (agentsPage.flow.<id>); reviewers — все рецензенты набора */
export const FLOW: { id: string; agents: string[] }[] = [
  { id: 'hint', agents: ['rules'] },
  { id: 'found', agents: ['inspector', 'reviewers'] },
  { id: 'quote', agents: ['quotes'] },
  { id: 'verify', agents: ['verifier'] },
  { id: 'merge', agents: ['merger'] },
  { id: 'number', agents: ['verifier', 'report'] },
  { id: 'use', agents: ['questions', 'checklist', 'conclusion', 'chat'] },
]

export const PRINCIPLES = ['graph', 'coverage', 'quotes', 'refute', 'schema', 'parallel', 'progress', 'kb'] as const
