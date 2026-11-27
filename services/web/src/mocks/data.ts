// Состояние мок-бэкенда в памяти. Основа — пример отчёта из общего контракта (sample_report.json).
import sampleJson from '@contracts/fixtures/sample_report.json'
import type {
  AppSettings,
  AuditEntry,
  ChatMessage,
  DocumentItem,
  FindingReview,
  ProgressEvent,
  ProviderId,
  ProviderSettings,
  Report,
  Run,
  RunStage,
  User,
} from '@/api/types'
import { seedNotes, type MockNote } from './wiki'

/** Как сейчас приходит от бэкенда: сырой текст исключения SDK. Веб показывает его в «Подробностях». */
export const RAW_400 =
  "BadRequestError: Error code: 400 - {'error': {'message': \"Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.\", 'type': 'invalid_request_error', 'param': 'max_tokens', 'code': 'unsupported_parameter'}}"
export const RAW_401 =
  "AuthenticationError: Error code: 401 - {'error': {'message': 'Incorrect API key provided: sk-bad***. You can find your API key at https://platform.openai.com/account/api-keys.', 'type': 'invalid_request_error', 'code': 'invalid_api_key'}}"

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
  { stage: 'checking_set', ms: 1800, message: 'Рецензенты набора: 6 ролей' },
  { stage: 'verifying', ms: 1200, message: 'Верификатор: перепроверка дефектов и слияние дублей' },
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
  knowledge: MockNote[]
  /** Явно созданные папки вики (в том числе пустые) */
  knowledgeFolders: string[]
  audit: AuditEntry[]
  auditSeq: number
  settings: AppSettings & { _embeddingsKey?: string }
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
    error: RAW_400,
    message: RAW_400,
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
      gemini: { provider: 'gemini', enabled: true, has_key: true, key_hint: '…a1b2', base_url: null, default_model: 'gemini-2.5-flash', updated_at: ago(300), extra_body: null, extra_body_set_review: null, max_output_tokens: null },
      openai: { provider: 'openai', enabled: true, has_key: false, key_hint: null, base_url: null, default_model: 'gpt-4.1-mini', updated_at: null },
      anthropic: { provider: 'anthropic', enabled: false, has_key: false, key_hint: null, base_url: null, default_model: 'claude-opus-4-1', updated_at: null },
      openai_compatible: { provider: 'openai_compatible', enabled: true, has_key: false, key_hint: null, base_url: 'http://vllm.example.local:8000/v1', default_model: 'local-model', updated_at: ago(300) },
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
    knowledge: seedNotes(ago),
    knowledgeFolders: ['Банк/Черновики'],
    audit: [
      { id: 4, ts: ago(60), actor: 'admin', action: 'finding.review', target: `${runId}/D-003`, details: { status: 'accepted' } },
      { id: 3, ts: ago(95), actor: 'admin', action: 'run.create', target: runId, details: { provider: 'gemini' } },
      { id: 2, ts: ago(200), actor: 'admin', action: 'run.create', target: 'run-failed', details: { provider: 'openai' } },
      { id: 1, ts: ago(240), actor: 'admin', action: 'document.upload', target: docId, details: { name: doc.name } },
    ],
    auditSeq: 4,
    settings: {
      default_provider: 'gemini',
      default_model: 'gemini-2.5-flash',
      run_timeout_s: 1800,
      min_interval_s: 0,
      max_attempts: 6,
      batch_size: 6,
      concurrency: 1,
      embeddings_provider: 'local',
      embeddings_model: null,
      embeddings_dim: null,
      max_upload_mb: 25,
      session_ttl_hours: 12,
      embeddings_has_key: false,
      embeddings_key_hint: null,
      updated_at: ago(300),
    },
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

/**
 * Живой список моделей так, как его вернул бы провайдер. Для локальной модели — по адресу сервера.
 * Ошибка — строкой, как у бэкенда.
 */
export function probeProvider(provider: ProviderId, apiKey: string | undefined, baseUrl: string | null | undefined): { ok: boolean; models: string[]; error?: string } {
  if (provider === 'openai_compatible') {
    if (!baseUrl) return { ok: false, models: [], error: 'Не задан адрес сервера (base URL)' }
    if (!/^https?:\/\/[^\s/]+/.test(baseUrl)) return { ok: false, models: [], error: `Некорректный адрес: ${baseUrl}` }
    if (/down|unreachable|offline/.test(baseUrl))
      return { ok: false, models: [], error: `APIConnectionError: Connection error. [Errno -2] Name or service not known (${baseUrl})` }
    if (/vllm\.example\.local/.test(baseUrl)) return { ok: true, models: ['local-model'] }
    return { ok: true, models: MODELS.openai_compatible }
  }
  if (!apiKey) return { ok: false, models: [], error: 'API-ключ не задан' }
  if (/^bad|invalid/i.test(apiKey) || apiKey.length < 8) return { ok: false, models: [], error: RAW_401 }
  return { ok: true, models: MODELS[provider] }
}

export const MODELS: Record<ProviderId, string[]> = {
  gemini: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-lite'],
  openai: ['gpt-4.1-mini', 'gpt-4.1', 'o4-mini'],
  anthropic: ['claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-opus-4-5', 'claude-sonnet-4-0', 'claude-3-7-sonnet-latest'],
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
