// Состояние мок-бэкенда в памяти. Основа — пример отчёта из общего контракта (sample_report.json).
import sampleJson from '@contracts/fixtures/sample_report.json'
import type {
  AuditEntry,
  ChatMessage,
  DocumentItem,
  FindingReview,
  KnowledgeItem,
  ProgressEvent,
  ProviderId,
  ProviderSettings,
  Report,
  Run,
  RunStage,
  User,
} from '@/api/types'

export const sampleReport = sampleJson as unknown as Report

export const MOCK_USERNAME = 'admin'
export const MOCK_PASSWORD = 'admin'

const now = () => new Date().toISOString()
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
let seq = 0
export const uid = (prefix = 'id') =>
  `${prefix}-${Date.now().toString(36)}-${(++seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`

/** Сценарий прогона: стадия и её длительность в мс. checking_requirements идёт по требованиям. */
const PLAN: { stage: RunStage; ms: number; message: string }[] = [
  { stage: 'queued', ms: 500, message: 'В очереди' },
  { stage: 'parsing', ms: 900, message: 'Извлечение текста' },
  { stage: 'segmenting', ms: 1000, message: 'Нарезка на требования' },
  { stage: 'rule_checks', ms: 700, message: 'Детерминированные проверки' },
  { stage: 'checking_requirements', ms: 4200, message: 'Проверка требований' },
  { stage: 'checking_set', ms: 1200, message: 'Проверка набора' },
  { stage: 'verifying', ms: 800, message: 'Проверка цитат' },
  { stage: 'rendering', ms: 600, message: 'Сводка и выгрузки' },
]
const TOTAL_MS = PLAN.reduce((s, p) => s + p.ms, 0)

interface MockRun extends Run {
  _startedAtMs: number
  _cancelled?: boolean
  _failAt?: RunStage
}

export interface Db {
  user: User
  password: string
  loggedIn: boolean
  providers: Record<ProviderId, ProviderSettings & { _key?: string }>
  documents: DocumentItem[]
  docTexts: Record<string, string>
  runs: MockRun[]
  reports: Record<string, Report>
  reviews: Record<string, Record<string, FindingReview>>
  chats: Record<string, ChatMessage[]>
  knowledge: (KnowledgeItem & { _readyAt?: number })[]
  audit: AuditEntry[]
  auditSeq: number
}

const SESSION_KEY = 'reqcheck.mock.session'
function readSession(): boolean {
  try {
    return sessionStorage.getItem(SESSION_KEY) === '1'
  } catch {
    return false
  }
}
export function setSession(on: boolean) {
  db.loggedIn = on
  try {
    if (on) sessionStorage.setItem(SESSION_KEY, '1')
    else sessionStorage.removeItem(SESSION_KEY)
  } catch {
    /* ignore */
  }
}

function seed(): Db {
  const docId = 'doc-sample'
  const runId = 'run-sample'
  const usage = { llm_calls: 14, prompt_tokens: 48210, completion_tokens: 9120, cost_usd: 0.031, duration_s: 42.7 }
  const sampleRun: MockRun = {
    id: runId,
    document_id: docId,
    document_name: sampleReport.passport.document_name,
    status: 'done',
    stage: 'done',
    progress: 1,
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    options: { language: 'ru', verify_pass: true, split_compound: true, fill_checklist: true },
    created_at: ago(95),
    started_at: ago(95),
    finished_at: ago(94),
    usage,
    summary: { ...sampleReport.summary, ready_for_development: sampleReport.conclusion.ready_for_development },
    _startedAtMs: Date.now() - 95 * 60_000,
  }
  const failedRun: MockRun = {
    ...sampleRun,
    id: 'run-failed',
    status: 'failed',
    stage: 'failed',
    progress: 0.42,
    provider: 'openai',
    model: 'gpt-4.1-mini',
    created_at: ago(200),
    started_at: ago(200),
    finished_at: ago(199),
    error: 'Провайдер отклонил ключ (401). Проверьте API-ключ в кабинете.',
    message: 'Провайдер отклонил ключ (401). Проверьте API-ключ в кабинете.',
    usage: { llm_calls: 3, prompt_tokens: 5100, completion_tokens: 0, cost_usd: 0.002, duration_s: 8.1 },
    summary: null,
  }
  const doc: DocumentItem = {
    id: docId,
    name: sampleReport.passport.document_name,
    format: 'md',
    size_bytes: new TextEncoder().encode(sampleReport.document.text).length,
    sha256: sampleReport.passport.document_sha256,
    created_at: ago(240),
    runs_count: 2,
    last_run: { id: runId, status: 'done', progress: 1, created_at: sampleRun.created_at, finished_at: sampleRun.finished_at, summary: sampleRun.summary },
  }
  const report: Report = {
    ...sampleReport,
    passport: { ...sampleReport.passport, provider: 'gemini', model: 'gemini-2.5-flash', run_at: sampleRun.created_at, agent_version: 'mock' },
    usage,
  }
  return {
    user: { id: 'u-admin', username: MOCK_USERNAME, role: 'admin', locale: 'ru' },
    password: MOCK_PASSWORD,
    loggedIn: readSession(),
    providers: {
      gemini: { provider: 'gemini', enabled: true, has_key: true, key_hint: '…a1b2', base_url: null, default_model: 'gemini-2.5-flash', updated_at: ago(300) },
      openai: { provider: 'openai', enabled: true, has_key: false, key_hint: null, base_url: null, default_model: 'gpt-4.1-mini', updated_at: null },
      anthropic: { provider: 'anthropic', enabled: false, has_key: false, key_hint: null, base_url: null, default_model: 'claude-sonnet-4-5', updated_at: null },
      openai_compatible: { provider: 'openai_compatible', enabled: true, has_key: false, key_hint: null, base_url: 'http://ollama:11434/v1', default_model: 'qwen2.5:7b-instruct', updated_at: ago(300) },
    },
    documents: [doc],
    docTexts: { [docId]: sampleReport.document.text },
    runs: [sampleRun, failedRun],
    reports: { [runId]: report },
    reviews: {
      [runId]: {
        'D-003': { finding_id: 'D-003', status: 'accepted', comment: 'Согласовано с аналитиком', updated_at: ago(60) },
      },
    },
    chats: {},
    knowledge: [
      { id: 'kb-builtin', title: 'Критерии ISO/IEC/IEEE 29148 и IEEE 830 (пересказ)', source: 'builtin', chunks: 36, status: 'ready', created_at: ago(500) },
      { id: 'kb-glossary', title: 'Глоссарий банка', source: 'upload', chunks: 12, status: 'ready', created_at: ago(400) },
      { id: 'kb-scan', title: 'Шаблон ТЗ (скан).pdf', source: 'upload', chunks: 0, status: 'failed', created_at: ago(380), error: 'В PDF нет текстового слоя — нужен OCR' },
    ],
    audit: [
      { id: 4, ts: ago(60), actor: 'admin', action: 'finding.review', target: `${runId}/D-003`, details: { status: 'accepted' } },
      { id: 3, ts: ago(95), actor: 'admin', action: 'run.create', target: runId, details: { provider: 'gemini' } },
      { id: 2, ts: ago(200), actor: 'admin', action: 'run.create', target: 'run-failed', details: { provider: 'openai' } },
      { id: 1, ts: ago(240), actor: 'admin', action: 'document.upload', target: docId, details: { name: doc.name } },
    ],
    auditSeq: 4,
  }
}

export let db: Db = seed()
export function resetDb() {
  db = seed()
}

export function logAudit(action: string, target: string | null, details: Record<string, unknown> = {}) {
  db.audit.unshift({ id: ++db.auditSeq, ts: now(), actor: db.user.username, action, target, details })
}

/** Текущее состояние прогона по прошедшему времени (имитация воркера). */
export function progressOf(run: MockRun): ProgressEvent {
  if (run.status === 'done' || run.status === 'failed' || run.status === 'cancelled') {
    return { run_id: run.id, stage: run.status, progress: run.progress, message: run.error ?? run.message ?? '', ts: run.finished_at ?? now() }
  }
  const elapsed = Date.now() - run._startedAtMs
  let acc = 0
  for (const step of PLAN) {
    if (elapsed < acc + step.ms) {
      const within = (elapsed - acc) / step.ms
      const ev: ProgressEvent = {
        run_id: run.id,
        stage: step.stage,
        progress: Math.min(0.99, (acc + within * step.ms) / TOTAL_MS),
        message: step.message,
        ts: now(),
      }
      if (step.stage === 'checking_requirements') {
        const total = sampleReport.requirements.length
        ev.total = total
        ev.current = Math.min(total, Math.floor(within * total) + 1)
        ev.message = `${step.message}: ${sampleReport.requirements[ev.current - 1].id}`
      }
      if (run._failAt === step.stage) return finish(run, 'failed', 'LLM returned invalid JSON 3 times')
      return ev
    }
    acc += step.ms
  }
  return finish(run, 'done')
}

function finish(run: MockRun, status: 'done' | 'failed', error?: string): ProgressEvent {
  run.status = status
  run.stage = status
  run.finished_at = now()
  run.progress = status === 'done' ? 1 : run.progress
  run.error = error ?? null
  run.message = error ?? (status === 'done' ? 'Готово' : '')
  run.usage = { llm_calls: 12, prompt_tokens: 41000, completion_tokens: 8300, cost_usd: 0.027, duration_s: TOTAL_MS / 1000 }
  if (status === 'done') {
    run.summary = { ...sampleReport.summary, ready_for_development: sampleReport.conclusion.ready_for_development }
    db.reports[run.id] = {
      ...sampleReport,
      passport: { ...sampleReport.passport, document_name: run.document_name, provider: run.provider, model: run.model, run_at: run.created_at, agent_version: 'mock' },
      usage: run.usage,
    }
  }
  const doc = db.documents.find((d) => d.id === run.document_id)
  if (doc) doc.last_run = { id: run.id, status, progress: run.progress, created_at: run.created_at, finished_at: run.finished_at, summary: run.summary }
  logAudit(`run.${status}`, run.id)
  return { run_id: run.id, stage: status, progress: run.progress, message: error ?? '', ts: now() }
}

export function materialize(run: MockRun): Run {
  const ev = progressOf(run)
  if (run.status !== 'done' && run.status !== 'failed' && run.status !== 'cancelled') {
    run.status = ev.stage
    run.stage = ev.stage
    run.progress = ev.progress
    run.message = ev.message
    if (ev.stage !== 'queued' && !run.started_at) run.started_at = now()
  }
  const { _startedAtMs, _cancelled, _failAt, ...pub } = run
  void _startedAtMs
  void _cancelled
  void _failAt
  return pub
}

export function newRun(doc: DocumentItem, provider: string, model: string, options: Run['options']): MockRun {
  const run: MockRun = {
    id: uid('run'),
    document_id: doc.id,
    document_name: doc.name,
    status: 'queued',
    stage: 'queued',
    progress: 0,
    message: 'В очереди',
    provider,
    model,
    options,
    created_at: now(),
    _startedAtMs: Date.now(),
    _failAt: /fail/i.test(doc.name) ? 'checking_set' : undefined,
  }
  db.runs.unshift(run)
  doc.runs_count += 1
  doc.last_run = { id: run.id, status: 'queued', progress: 0, created_at: run.created_at }
  return run
}

export const MODELS: Record<ProviderId, string[]> = {
  gemini: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-lite'],
  openai: ['gpt-4.1-mini', 'gpt-4.1', 'o4-mini'],
  anthropic: ['claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-opus-4-1'],
  openai_compatible: ['qwen2.5:7b-instruct', 'llama3.1:8b-instruct', 'mistral-nemo:12b'],
}

export function chatAnswer(question: string, report: Report): string {
  const crit = report.findings.filter((f) => f.severity === 'critical')
  const q = question.toLowerCase()
  if (/(перв|first|исправ|fix)/.test(q)) {
    return `В первую очередь:\n\n${report.conclusion.top_fixes.map((f, i) => `${i + 1}. ${f}`).join('\n')}\n\nЭто блокеры: без них требования нельзя однозначно реализовать и проверить.`
  }
  return (
    `По отчёту найдено ${report.summary.findings_total} дефектов, из них критических — ${crit.length}: ` +
    crit.map((f) => `**${f.id}** «${f.title}»`).join(', ') +
    `.\n\n${report.conclusion.rationale}\n\n_Это ответ мок-сервера: настоящий ответ формирует модель по отчёту и базе знаний._`
  )
}
