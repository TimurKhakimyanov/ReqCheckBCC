import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Bot, Copy, Ruler } from 'lucide-react'
import { forwardRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/api/client'
import type { Finding, FindingReview, FindingWithReview, ReviewStatus } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/input'
import { cn } from '@/shared/utils'
import { EYEBROW, SEV_VAR } from './ui'

/** Решения по дефекту: повторное нажатие на выбранное возвращает «не разобран». */
const DECISIONS: Exclude<ReviewStatus, 'open'>[] = ['accepted', 'false_positive', 'fixed']
export const STATUS_TONE: Record<ReviewStatus, string> = {
  open: 'text-muted-foreground',
  accepted: 'text-teal',
  false_positive: 'text-muted-foreground',
  fixed: 'text-sev-major',
}
const DECISION_ON: Record<Exclude<ReviewStatus, 'open'>, string> = {
  accepted: 'border-teal bg-teal text-card',
  false_positive: 'border-muted-foreground bg-muted-foreground text-card',
  fixed: 'border-sev-major bg-sev-major text-card',
}

export function useReviewMutation(runId: string) {
  const qc = useQueryClient()
  const key = ['findings', runId]
  return useMutation({
    mutationFn: (v: { findingId: string; status: ReviewStatus; comment?: string }) =>
      api.reviewFinding(runId, v.findingId, { status: v.status, comment: v.comment }),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: key })
      const prev = qc.getQueryData<FindingWithReview[]>(key)
      qc.setQueryData<FindingWithReview[]>(key, (xs) =>
        xs?.map((x) =>
          x.finding.id === v.findingId ? { ...x, review: { ...x.review, status: v.status, comment: v.comment ?? x.review.comment } } : x,
        ),
      )
      return { prev }
    },
    onError: (e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev)
      toast.error((e as Error).message)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  })
}

interface Props {
  finding: Finding
  review?: FindingReview
  runId: string
  active: boolean
  /** Где дефект: «Ф-2 · R-002» или раздел документа */
  where: string
  onSelect: (locIndex?: number) => void
  onCollapse: () => void
  onRequirement?: (reqId: string) => void
}

export const FindingCard = forwardRef<HTMLElement, Props>(function FindingCard(
  { finding: f, review, runId, active, where, onSelect, onCollapse, onRequirement },
  ref,
) {
  const { t } = useTranslation()
  const status = review?.status ?? 'open'
  const [comment, setComment] = useState(review?.comment ?? '')
  const [editing, setEditing] = useState(false)
  const mut = useReviewMutation(runId)

  const decide = (s: Exclude<ReviewStatus, 'open'>) =>
    mut.mutate({ findingId: f.id, status: status === s ? 'open' : s, comment: comment || undefined })

  return (
    <article
      ref={ref}
      data-finding={f.id}
      data-active={active}
      onClick={() => !active && onSelect()}
      className={cn(
        'border bg-card text-sm transition-[box-shadow,border-color] duration-200',
        active ? 'border-foreground' : 'cursor-pointer hover:border-foreground/30',
        status !== 'open' && !active && 'opacity-75',
      )}
      style={{ boxShadow: `inset 3px 0 0 ${SEV_VAR[f.severity]}` }}
    >
      <button
        type="button"
        aria-expanded={active}
        onClick={(e) => {
          e.stopPropagation()
          if (active) onCollapse()
          else onSelect()
        }}
        className="rc-focusable flex w-full cursor-pointer flex-col gap-2 py-3 pr-3.5 pl-4 text-left"
      >
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px]">
          <span className="text-xs font-semibold text-foreground">{f.id}</span>
          <span className="border px-1.5 text-foreground/80" title={t(`criteria.${f.criterion}.description`)}>
            {t(`criteria.${f.criterion}.title`)}
          </span>
          {where && <span className="max-w-full truncate text-muted-foreground">{where}</span>}
          <span className={cn('ml-auto', STATUS_TONE[status])}>{status === 'open' ? t('report.notReviewed') : `● ${t(`review.${status}`)}`}</span>
        </span>
        <span className="text-[0.875rem] leading-snug font-medium">{f.title}</span>
      </button>

      {active && (
        <div className="grid gap-3 border-t px-4 pt-3 pb-4" onClick={(e) => e.stopPropagation()}>
          <div className="grid gap-1.5">
            {f.locations.map((loc, i) => (
              <button
                key={i}
                type="button"
                onClick={() => onSelect(i)}
                className="rc-focusable cursor-pointer border-l-2 bg-secondary px-2.5 py-1.5 text-left text-[0.8125rem] leading-normal transition-colors hover:bg-accent"
                style={{ borderLeftColor: SEV_VAR[f.severity] }}
              >
                «{loc.quote}»{' '}
                <span className="font-mono text-[11px] text-muted-foreground">
                  {[loc.page ? t('report.page', { page: loc.page }) : null, loc.section].filter(Boolean).join(' · ')}
                </span>
                {loc.verified === false && (
                  <span className="mt-0.5 block font-mono text-[11px] text-warning" title={t('report.unverifiedHint')}>
                    {t('report.unverified')}
                  </span>
                )}
              </button>
            ))}
          </div>

          <p className="text-[0.8125rem] leading-relaxed">
            <span className={cn(EYEBROW, 'mr-2')}>{t('report.why')}</span>
            <span>{f.explanation}</span>
          </p>

          {f.suggestion && (
            <div className="border border-teal/30 bg-teal/5 px-2.5 py-2 text-[0.8125rem] leading-relaxed">
              <div className="mb-0.5 flex items-center justify-between gap-2">
                <span className={cn(EYEBROW, 'text-teal')}>{t('report.howToFix')}</span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="size-6 rounded-none"
                  aria-label={t('common.copy')}
                  onClick={() => navigator.clipboard?.writeText(f.suggestion!).then(() => toast.success(t('common.copied')))}
                >
                  <Copy className="size-3.5" />
                </Button>
              </div>
              {f.suggestion}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1" title={f.source === 'rule' ? t('report.sourceRuleHint') : t('report.sourceLlmHint')}>
              {f.source === 'rule' ? <Ruler className="size-3" /> : <Bot className="size-3" />}
              {f.source === 'rule' ? t('report.sourceRule') : t('report.sourceLlm')}
            </span>
            {(f.requirement_ids?.length ?? 0) > 0 && (
              <span className="inline-flex flex-wrap items-center gap-1.5">
                {t(f.scope === 'set' ? 'report.scopeSet' : 'report.scopeReq')}:
                {f.requirement_ids!.map((r) => (
                  <button key={r} type="button" className="cursor-pointer text-sev-major hover:underline" onClick={() => onRequirement?.(r)}>
                    {r}
                  </button>
                ))}
              </span>
            )}
          </div>

          <div className="grid gap-2 border-t pt-3">
            <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('review.label')}>
              {DECISIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={status === s}
                  disabled={mut.isPending}
                  onClick={() => decide(s)}
                  className={cn(
                    'rc-focusable min-h-8 cursor-pointer border px-3 font-mono text-xs transition-colors disabled:opacity-60',
                    status === s ? DECISION_ON[s] : 'border-input bg-card hover:border-foreground/40',
                  )}
                >
                  {t(`review.${s}`)}
                </button>
              ))}
            </div>
            {editing ? (
              <div className="grid gap-2">
                <Textarea
                  autoFocus
                  rows={2}
                  value={comment}
                  placeholder={t('review.commentPlaceholder')}
                  onChange={(e) => setComment(e.target.value)}
                  className="rounded-none"
                />
                <div className="flex justify-end gap-2">
                  <Button size="sm" variant="ghost" className="rounded-none" onClick={() => setEditing(false)}>
                    {t('common.cancel')}
                  </Button>
                  <Button
                    size="sm"
                    className="rounded-none"
                    onClick={() => {
                      mut.mutate({ findingId: f.id, status, comment })
                      setEditing(false)
                    }}
                  >
                    {t('common.save')}
                  </Button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="cursor-pointer self-start text-left text-xs text-sev-major hover:underline"
                onClick={() => setEditing(true)}
              >
                {review?.comment ? (
                  <span className="text-muted-foreground">{review.comment}</span>
                ) : (
                  <>
                    <span aria-hidden>+ </span>
                    <span>{t('review.addComment')}</span>
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      )}
    </article>
  )
})
