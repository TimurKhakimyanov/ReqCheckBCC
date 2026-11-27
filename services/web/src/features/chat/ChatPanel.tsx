import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Bot, Eraser, SendHorizontal, Square, X } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api, streamChat } from '@/api/client'
import type { ChatMessage } from '@/api/types'
import { Markdown } from '@/components/Markdown'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/input'
import { Spinner } from '@/components/ui/misc'
import { useReport } from '@/features/report/context'
import { cn } from '@/shared/utils'

export function ChatPanel({ runId, onClose }: { runId: string; onClose: () => void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { findingsById, goToFinding, goToRequirement } = useReport()
  const key = ['chat', runId]
  const history = useQuery({ queryKey: key, queryFn: () => api.chat(runId) })
  const [input, setInput] = useState('')
  const [pending, setPending] = useState<{ question: string; answer: string } | null>(null)
  const abort = useRef<AbortController | null>(null)
  const bottom = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' })
  }, [history.data, pending?.answer])
  useEffect(() => () => abort.current?.abort(), [])

  const send = async (text: string) => {
    const message = text.trim()
    if (!message || pending) return
    setInput('')
    setPending({ question: message, answer: '' })
    const ctrl = new AbortController()
    abort.current = ctrl
    try {
      await streamChat(
        runId,
        { message },
        {
          signal: ctrl.signal,
          onToken: (tok) => setPending((p) => (p ? { ...p, answer: p.answer + tok } : p)),
          onDone: () => {},
        },
      )
    } catch (e) {
      if ((e as Error).name !== 'AbortError') toast.error((e as Error).message)
    } finally {
      abort.current = null
      await qc.invalidateQueries({ queryKey: key })
      setPending(null)
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    void send(input)
  }

  const clear = async () => {
    await api.clearChat(runId).catch((e) => toast.error(e.message))
    qc.setQueryData<ChatMessage[]>(key, [])
  }

  const linker = (tok: string, k: string) =>
    tok.startsWith('D-') && findingsById[tok] ? (
      <button key={k} type="button" className="font-mono font-medium text-primary hover:underline" onClick={() => goToFinding(tok)}>
        {tok}
      </button>
    ) : tok.startsWith('R-') ? (
      <button key={k} type="button" className="font-mono font-medium text-primary hover:underline" onClick={() => goToRequirement(tok)}>
        {tok}
      </button>
    ) : null

  const messages = history.data ?? []
  const suggestions = [t('chat.s1'), t('chat.s2'), t('chat.s3')]

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
        <div className="flex items-center gap-2 font-semibold">
          <Bot className="size-4" />
          {t('chat.title')}
        </div>
        <div className="flex items-center">
          <Button variant="ghost" size="icon-sm" onClick={clear} disabled={!messages.length || !!pending} title={t('chat.clear')} aria-label={t('chat.clear')}>
            <Eraser />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label={t('common.close')}>
            <X />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4" data-testid="chat-messages">
        {history.isPending ? (
          <Spinner />
        ) : messages.length === 0 && !pending ? (
          <div className="grid gap-3 text-sm">
            <p className="text-muted-foreground">{t('chat.intro')}</p>
            {suggestions.map((s) => (
              <button key={s} type="button" onClick={() => send(s)} className="rounded-lg border px-3 py-2 text-left hover:bg-muted">
                {s}
              </button>
            ))}
          </div>
        ) : (
          <div className="grid gap-3 text-sm">
            {messages.map((m) => (
              <Bubble key={m.id} role={m.role}>
                {m.role === 'assistant' ? <Markdown text={m.content} linker={linker} /> : m.content}
              </Bubble>
            ))}
            {pending && (
              <>
                <Bubble role="user">{pending.question}</Bubble>
                <Bubble role="assistant">
                  {pending.answer ? <Markdown text={pending.answer} linker={linker} /> : <Spinner className="size-3.5" />}
                </Bubble>
              </>
            )}
          </div>
        )}
        <div ref={bottom} />
      </div>

      <form onSubmit={submit} className="border-t p-3">
        <div className="flex items-end gap-2">
          <Textarea
            rows={2}
            className="min-h-10 resize-none"
            placeholder={t('chat.placeholder')}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send(input)
              }
            }}
          />
          {pending ? (
            <Button type="button" size="icon" variant="outline" onClick={() => abort.current?.abort()} aria-label={t('chat.stop')}>
              <Square />
            </Button>
          ) : (
            <Button type="submit" size="icon" disabled={!input.trim()} aria-label={t('chat.send')}>
              <SendHorizontal />
            </Button>
          )}
        </div>
      </form>
    </div>
  )
}

function Bubble({ role, children }: { role: 'user' | 'assistant'; children: ReactNode }) {
  return (
    <div className={cn('max-w-[92%] rounded-lg px-3 py-2 leading-relaxed', role === 'user' ? 'ml-auto bg-primary text-primary-foreground' : 'bg-muted')}>
      {children}
    </div>
  )
}
