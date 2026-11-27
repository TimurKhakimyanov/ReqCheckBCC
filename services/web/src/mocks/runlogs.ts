// Журнал прогона для мок-режима: правдоподобные записи агентов, вызовы LLM и итог — как пишет воркер (worker/runlog.py).
import type { AuditEntry, Run, RunLogEntry, RunLogs, RunStage } from '@/api/types'
import { isTerminal } from '@/api/types'
import { sampleReport } from './data'

const STAGES: RunStage[] = ['parsing', 'segmenting', 'rule_checks', 'checking_requirements', 'checking_set', 'verifying', 'rendering']
const ROLES = ['логика правил', 'согласованность спецификаций', 'системный аналитик', 'тест-аналитик', 'архитектор интеграций', 'риски и ИБ']

export function mockRunLogs(run: Run, audit: AuditEntry[]): RunLogs {
  const items: RunLogEntry[] = []
  const start = Date.parse(run.started_at ?? run.created_at)
  let t = start
  let id = 0
  const reqs = sampleReport.requirements.map((r) => r.id)
  const failAt: RunStage | null = run.status === 'failed' ? 'checking_requirements' : null
  const reached = isTerminal(run.status) ? (run.status === 'done' ? STAGES.length : STAGES.indexOf(failAt ?? 'parsing') + 1) : Math.max(0, STAGES.indexOf(run.status) + 1)

  const add = (e: Omit<RunLogEntry, 'id' | 'ts' | 'data'> & { data?: Record<string, unknown> }, ms = 120) => {
    t += ms
    items.push({ id: ++id, ts: new Date(t).toISOString(), data: {}, ...e })
  }
  const llm = (stage: RunStage, schema: string, ms: number, p: number, c: number) =>
    add(
      {
        level: 'info',
        source: 'llm',
        stage,
        message: `LLM ${run.provider}/${run.model}: ${schema} — ответ за ${ms} мс, токены ${p}→${c}`,
        data: { kind: 'llm_call', llm_provider: run.provider, llm_model: run.model, schema, latency_ms: ms, prompt_tokens: p, completion_tokens: c, attempt: 1, truncated: false, logger: 'req_core.llm' },
      },
      ms,
    )

  add({ level: 'info', source: 'worker', stage: 'queued', message: `Прогон запущен: ${run.provider}/${run.model}, документ «${run.document_name}»`, data: { provider: run.provider, model: run.model, options: run.options, run_timeout_s: 1800 } }, 0)
  add({ level: 'info', source: 'progress', stage: 'parsing', message: 'Загрузка документа', data: { progress: 0.01 } })
  add({ level: 'info', source: 'worker', stage: 'parsing', message: 'База знаний: найдено фрагментов — 2', data: { snippets: ['Требование должно быть проверяемым…', 'Глоссарий: «оператор» — сотрудник банка…'] } })

  for (let i = 0; i < reached; i++) {
    const stage = STAGES[i]
    const failed = failAt === stage
    switch (stage) {
      case 'parsing':
        add({ level: 'info', source: 'progress', stage, message: 'Извлечение текста', data: { progress: 0.03 } }, 300)
        add({ level: 'info', source: 'core', stage, message: `Документ разобран: ${sampleReport.document.text.length.toLocaleString('ru')} символов`, data: { logger: 'req_core.parsing' } })
        break
      case 'segmenting':
        add({ level: 'info', source: 'progress', stage, message: 'Нарезка на требования', data: { progress: 0.08 } })
        llm(stage, 'SegmentResult', 6400, 9120, 2210)
        add({ level: 'info', source: 'core', stage, message: 'Требование модели не найдено в тексте: «Система должна обеспечивать…»', data: { logger: 'req_core.pipeline' } })
        add({ level: 'info', source: 'progress', stage, message: `Найдено требований: ${reqs.length}`, current: reqs.length, total: reqs.length, data: { progress: 0.2 } })
        break
      case 'rule_checks':
        add({ level: 'info', source: 'progress', stage, message: 'Детерминированные проверки', data: { progress: 0.25 } }, 200)
        add({ level: 'info', source: 'core', stage, message: 'Правила: размытые формулировки — 3, TBD — 1', data: { logger: 'req_core.rules' } })
        break
      case 'checking_requirements': {
        const batches = [reqs.slice(0, Math.ceil(reqs.length / 2)), reqs.slice(Math.ceil(reqs.length / 2))].filter((b) => b.length)
        for (const [bi, b] of batches.entries()) {
          add({ level: 'info', source: 'progress', stage, message: `Проверка требований ${b[0]}–${b.at(-1)}`, current: bi * batches[0].length, total: reqs.length, data: { progress: 0.3 } })
          if (failed) {
            add({ level: 'warning', source: 'llm', stage, message: `LLM ${run.provider}: RateLimitError; повтор 1/6 через 4 с`, data: { logger: 'req_core.llm' } }, 900)
            add({ level: 'info', source: 'progress', stage, message: 'Лимит запросов провайдера: повтор через 4 с', data: { progress: 0.3 } }, 4000)
            break
          }
          llm(stage, 'RequirementBatchResult', 8800 + bi * 1300, 12400, 3100)
          b.forEach((rid, k) => add({ level: 'info', source: 'progress', stage, message: `Проверено требование ${rid}`, current: bi * batches[0].length + k + 1, total: reqs.length, data: { progress: 0.3 + 0.4 * ((bi * batches[0].length + k + 1) / reqs.length) } }, 30))
        }
        if (failed) {
          add({ level: 'error', source: 'worker', stage, message: `Прогон завершился ошибкой: ${run.error ?? ''}`, data: { error: run.error, logger: 'worker.tasks', exc: `Traceback (most recent call last):\n  File "/app/worker/tasks.py", line 297, in _execute_run\n    report = run_with_watchdog(...)\n  File "/app/req_core/llm.py", line 330, in _with_retry\n    return self._reply(fn())\n${run.error ?? 'LLMError'}` } }, 400)
          add({ level: 'error', source: 'progress', stage: 'failed', message: run.error ?? 'Ошибка', data: { progress: 0 } })
        }
        break
      }
      case 'checking_set':
        add({ level: 'info', source: 'progress', stage, message: 'Рецензенты набора: 6 ролей', data: { progress: 0.72 } })
        ROLES.forEach((r, k) => llm(stage, `RoleReviewResult · ${r}`, 5200 + k * 700, 14800, 1900 + k * 120))
        add({ level: 'warning', source: 'core', stage, message: 'Шаг «рецензент: архитектор интеграций» не выполнен моделью: ответ не прошёл схему RoleReviewResult', data: { logger: 'req_core.pipeline' } })
        break
      case 'verifying':
        add({ level: 'info', source: 'progress', stage, message: 'Верификатор: перепроверка дефектов и слияние дублей', data: { progress: 0.82 } })
        llm(stage, 'VerifierResult', 7100, 10300, 2600)
        add({ level: 'info', source: 'core', stage, message: 'Верификатор отклонил D-011 «Нет единиц измерения»: единицы указаны в таблице 3', data: { logger: 'req_core.pipeline' } })
        llm(stage, 'DedupResult', 3900, 6100, 900)
        add({ level: 'info', source: 'core', stage, message: 'Верификатор: кандидатов 21, отклонено 3, слито дублей 2, без ответа 0', data: { logger: 'req_core.pipeline' } })
        break
      case 'rendering':
        add({ level: 'info', source: 'progress', stage, message: 'Уточняющие вопросы и итог', data: { progress: 0.88 } })
        llm(stage, 'QuestionsResult', 4300, 7400, 1500)
        llm(stage, 'Conclusion', 3100, 5200, 800)
        add({ level: 'info', source: 'progress', stage, message: 'Выгрузка отчёта (MD, DOCX, PDF)', data: { progress: 0.92 } })
        for (const f of ['MD', 'DOCX', 'PDF']) add({ level: 'info', source: 'worker', stage, message: `Отчёт ${f} выгружен`, data: { key: `reports/${run.id}/report.${f.toLowerCase()}` } }, 200)
        add({ level: 'info', source: 'progress', stage, message: 'Индексация для поиска', data: { progress: 0.97 } })
        break
    }
    if (failed) break
  }

  if (run.status === 'done') {
    const u = run.usage
    add({ level: 'info', source: 'worker', stage: 'rendering', message: `Итог: вызовов LLM ${u?.llm_calls ?? 0}, токены ${u?.prompt_tokens ?? 0}→${u?.completion_tokens ?? 0}, ${Math.round(u?.duration_s ?? 0)} с`, data: { ...(u ?? {}) } })
    add({ level: 'info', source: 'progress', stage: 'done', message: run.message || `Готово: требований ${reqs.length}, дефектов ${run.summary?.findings_total ?? 0}`, data: { progress: 1 } })
  }
  if (run.status === 'cancelled') add({ level: 'info', source: 'progress', stage: 'cancelled', message: 'Прогон отменён', data: { progress: run.progress } })

  const acts = audit.filter((a) => a.target === run.id || a.target?.startsWith(`${run.id}/`)).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
  return { run, items, audit: acts, truncated: false }
}
