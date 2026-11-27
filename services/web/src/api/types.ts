// Типы HTTP API (docs/api.md). Модели отчёта — в report.gen.ts (генерируются из JSON Schema контракта).
import type { Criterion, Finding, Report, Severity, Usage } from './report.gen'

export type { Criterion, Finding, Report, Severity, Usage }
export type {
  CheckVerdict,
  ChecklistAnswer,
  ChecklistItem,
  Conclusion,
  CriterionCheck,
  FindingScope,
  FindingSource,
  Requirement,
  RequirementAssessment,
  RequirementKind,
  RunPassport,
  SourceLocation,
  Summary1 as ReportSummary,
} from './report.gen'

export type ProviderId = 'gemini' | 'openai' | 'anthropic' | 'openai_compatible'
export const PROVIDERS: ProviderId[] = ['gemini', 'openai', 'anthropic', 'openai_compatible']

export type RunStage =
  | 'queued'
  | 'parsing'
  | 'segmenting'
  | 'rule_checks'
  | 'checking_requirements'
  | 'checking_set'
  | 'verifying'
  | 'rendering'
  | 'done'
  | 'failed'
  | 'cancelled'

export const PIPELINE_STAGES: RunStage[] = [
  'queued',
  'parsing',
  'segmenting',
  'rule_checks',
  'checking_requirements',
  'checking_set',
  'verifying',
  'rendering',
  'done',
]
export const TERMINAL_STAGES: RunStage[] = ['done', 'failed', 'cancelled']
export const isTerminal = (s: RunStage) => TERMINAL_STAGES.includes(s)

export interface User {
  id: string
  username: string
  role: 'admin'
  locale: string
}

export interface ProviderSettings {
  provider: ProviderId
  enabled: boolean
  has_key: boolean
  key_hint: string | null
  base_url: string | null
  default_model: string | null
  updated_at: string | null
}

export interface ProviderUpdate {
  api_key?: string
  base_url?: string
  enabled?: boolean
  default_model?: string
}

export interface ProviderTestResult {
  ok: boolean
  latency_ms: number
  error?: string | null
}

export type DocumentFormat = 'pdf' | 'docx' | 'md' | 'txt'

export interface RunShort {
  id: string
  status: RunStage
  progress?: number
  created_at: string
  finished_at?: string | null
  /** Бэкенд в RunShort их не отдаёт — есть только в полном Run. */
  provider?: string
  model?: string
  summary?: RunSummary | null
}

export interface DocumentItem {
  id: string
  name: string
  format: DocumentFormat
  size_bytes: number
  sha256: string
  created_at: string
  runs_count: number
  last_run?: RunShort | null
}

/** Опции прогона — req_contracts.llm.ValidationOptions. knowledge_snippets заполняет воркер, не UI. */
export interface ValidationOptions {
  language?: string
  verify_pass?: boolean
  split_compound?: boolean
  fill_checklist?: boolean
}

export const DEFAULT_OPTIONS: Required<ValidationOptions> = {
  language: 'ru',
  verify_pass: false,
  split_compound: true,
  fill_checklist: true,
}

export interface RunSummary {
  requirements_total: number
  findings_total: number
  by_severity: Partial<Record<Severity, number>>
  critical_finding_ids?: string[]
  ready_for_development?: boolean
}

export interface Run {
  id: string
  document_id: string
  document_name: string
  status: RunStage
  stage: RunStage
  progress: number
  /** Текст последнего события прогресса; для failed совпадает с error. */
  message?: string
  provider: string
  model: string
  options: ValidationOptions
  created_at: string
  started_at?: string | null
  finished_at?: string | null
  error?: string | null
  usage?: Usage | null
  summary?: RunSummary | null
}

export interface RunCreate {
  document_id: string
  /** Необязательны: бэкенд берёт провайдер по умолчанию и его default_model. */
  provider?: string
  model?: string
  options?: ValidationOptions
}

export interface ProgressEvent {
  run_id?: string | null
  stage: RunStage
  progress: number
  message: string
  current?: number | null
  total?: number | null
  ts: string
}

export type ReviewStatus = 'open' | 'accepted' | 'false_positive' | 'fixed'
export const REVIEW_STATUSES: ReviewStatus[] = ['open', 'accepted', 'false_positive', 'fixed']

export interface FindingReview {
  finding_id: string
  status: ReviewStatus
  comment?: string | null
  updated_at?: string | null
}

export interface FindingWithReview {
  finding: Finding
  review: FindingReview
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  created_at: string
}

export interface SearchHit {
  score: number
  kind: 'requirement' | 'finding'
  text: string
  run_id: string
  document_name: string
  requirement_id?: string | null
  finding_id?: string | null
}

export interface KnowledgeItem {
  id: string
  title: string
  source: 'builtin' | 'upload' | 'manual'
  chunks: number
  status: 'indexing' | 'ready' | 'failed'
  created_at: string
  error?: string | null
}

export interface UsageRow extends Usage {
  runs?: number
}

export interface UsageByProvider extends UsageRow {
  provider: string
  model?: string | null
}

export interface UsageByDay extends UsageRow {
  /** YYYY-MM-DD (UTC) */
  date: string
}

export interface UsageResponse {
  totals: UsageRow
  by_provider: UsageByProvider[]
  by_day: UsageByDay[]
}

export interface AuditEntry {
  id: string | number
  ts: string
  actor: string
  action: string
  target: string | null
  details: Record<string, unknown> | string | null
}

export interface Page<T> {
  items: T[]
  total: number
}

export interface Health {
  status: 'ok' | 'degraded'
  version: string
  /** "ok" или текст ошибки */
  checks: Record<string, string>
  limits?: { max_upload_mb?: number }
}

export interface ModelsResponse {
  models: string[]
  /** Провайдер недоступен — models содержит список-подсказку. */
  error?: string | null
}

export type ExportFormat = 'md' | 'pdf' | 'docx' | 'json'
