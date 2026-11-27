// Вопросы автору по ходу прогона — веб-аналог `run.py --ask` bbc-agent. Прогон с options.ask_author после
// перепроверки останавливается на уточняющих вопросах; ответы отсюда учитываются в этом же прогоне:
// «Редактор по ответам» переписывает требования и снимает закрытые дефекты, затем выносится итог.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MessageCircleQuestion, Send, SkipForward } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/api/client'
import type { PendingQuestions, QuestionPriority, Run } from '@/api/types'
import { Button } from '@/components/ui/button'
import { cn } from '@/shared/utils'

const PRIORITY_TONE: Record<QuestionPriority, string> = {
  blocker: 'bg-sev-critical-bg text-sev-critical',
  important: 'bg-sev-major-bg text-sev-major',
  minor: 'bg-secondary text-muted-foreground',
}

type Draft = Record<string, { choice?: number; custom?: string }>

export function AskAuthorPanel({ run, active }: { run: Run; active: boolean }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const key = ['run-questions', run.id]
  const enabled = active && !!run.options?.ask_author
  const pending = useQuery({ queryKey: key, queryFn: () => api.runQuestions(run.id), enabled, refetchInterval: enabled ? 3000 : false })
  const [draft, setDraft] = useState<Draft>({})
  const send = useMutation({
    mutationFn: (answers: Record<string, string>) => api.sendRunAnswers(run.id, answers),
    onSuccess: (_, answers) => {
      qc.setQueryData<PendingQuestions>(key, { waiting: false, questions: [] })
      setDraft({})
      toast.success(t(Object.keys(answers).length ? 'ask.sent' : 'ask.skipped'))
    },
    onError: (e) => toast.error(t('ask.failed'), { description: e instanceof Error ? e.message : String(e) }),
  })

  const questions = enabled && pending.data?.waiting ? pending.data.questions : []
  if (!questions.length) return null

  const answerOf = (id: string): string | null => {
    const a = draft[id]
    const q = questions.find((x) => x.id === id)
    if (a?.choice != null && q?.options?.[a.choice] != null) return q.options[a.choice]
    return a?.custom?.trim() || null
  }
  const answers = Object.fromEntries(questions.flatMap((q) => (answerOf(q.id) ? [[q.id, answerOf(q.id)!]] : [])))
  const answered = Object.keys(answers).length
  const set = (id: string, v: Draft[string]) => setDraft((d) => ({ ...d, [id]: v }))

  return (
    <section
      aria-labelledby="ask-author-title"
      className="rc-fade grid gap-4 rounded-2xl border-2 border-accent-2/50 bg-card p-5 shadow-raised"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex max-w-3xl gap-3">
          <MessageCircleQuestion className="mt-0.5 size-5 shrink-0 text-accent-2" aria-hidden />
          <div className="grid gap-1">
            <h2 id="ask-author-title" className="text-lg font-medium tracking-tight">
              {t('ask.title')}
            </h2>
            <p className="text-sm text-muted-foreground">{t('ask.hint')}</p>
          </div>
        </div>
        <span className="text-sm" aria-live="polite">
          {t('ask.answered', { n: answered, total: questions.length })}
        </span>
      </header>

      {questions.map((q) => {
        const prio = q.priority ?? 'important'
        const a = draft[q.id] ?? {}
        return (
          <article key={q.id} className="grid gap-2.5 rounded-xl bg-background/60 p-4" aria-label={q.id}>
            <div className="flex flex-wrap items-center gap-3 font-mono text-xs">
              <span className="text-muted-foreground">{q.id}</span>
              <span className={cn('rounded-full px-2.5 py-0.5 font-sans font-medium', PRIORITY_TONE[prio])}>{t(`questions.priority.${prio}`)}</span>
              <span className="text-muted-foreground">
                {t('questions.addressee')}: <span className="text-foreground">{q.addressee}</span>
              </span>
            </div>
            <h3 className="leading-snug font-medium">{q.question}</h3>
            {q.why && <p className="text-sm text-muted-foreground">{q.why}</p>}
            <div className="flex flex-wrap gap-2">
              {(q.options?.length ?? 0) > 0 && (
                <div role="radiogroup" aria-label={t('questions.options')} className="flex flex-wrap gap-2">
                  {q.options!.map((o, k) => (
                    <label
                      key={k}
                      className={cn(
                        'flex cursor-pointer items-center gap-2 rounded-xl px-3.5 py-2 text-sm transition-colors',
                        a.choice === k ? 'bg-success/15 ring-1 ring-success' : 'bg-secondary hover:bg-accent',
                      )}
                    >
                      <input
                        type="radio"
                        name={`ask-${run.id}-${q.id}`}
                        className="accent-[var(--success)]"
                        checked={a.choice === k}
                        onChange={() => set(q.id, { choice: k })}
                      />
                      {o}
                    </label>
                  ))}
                </div>
              )}
              <label className="flex min-w-56 flex-1 items-center gap-2 rounded-xl border border-dashed px-3.5 py-2 text-sm">
                <span className="font-mono text-xs text-muted-foreground">{t('questions.custom')}</span>
                <input
                  type="text"
                  className="min-w-0 flex-1 bg-transparent outline-none"
                  placeholder={t('questions.customPlaceholder')}
                  value={a.custom ?? ''}
                  onChange={(e) => set(q.id, { choice: e.target.value ? undefined : a.choice, custom: e.target.value })}
                />
              </label>
            </div>
          </article>
        )
      })}

      <footer className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" onClick={() => send.mutate({})} disabled={send.isPending}>
          <SkipForward />
          {t('ask.skip')}
        </Button>
        <Button onClick={() => send.mutate(answers)} disabled={!answered || send.isPending}>
          <Send />
          {t('ask.send')}
        </Button>
      </footer>
    </section>
  )
}
