import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Bot, Check, CircleAlert, Copy, MapPin, MessageSquare, Ruler, ShieldQuestion, Wrench } from 'lucide-react'
import { forwardRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/api/client'
import type { Finding, FindingReview, FindingWithReview, ReviewStatus } from '@/api/types'
import { REVIEW_STATUSES } from '@/api/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/input'
import { SeverityBadge } from '@/features/runs/RunBits'
import { cn } from '@/shared/utils'

const STATUS_ICON: Record<ReviewStatus, typeof Check> = {
  open: CircleAlert,
  accepted: Check,
  false_positive: ShieldQuestion,
  fixed: Wrench,
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
  onSelect: (locIndex?: number) => void
  onRequirement?: (reqId: string) => void
}

export const FindingCard = forwardRef<HTMLDivElement, Props>(function FindingCard(
  { finding: f, review, runId, active, onSelect, onRequirement },
  ref,
) {
  const { t } = useTranslation()
  const status = review?.status ?? 'open'
  const [comment, setComment] = useState(review?.comment ?? '')
  const [editing, setEditing] = useState(false)
  const mut = useReviewMutation(runId)

  const setStatus = (s: ReviewStatus) => mut.mutate({ findingId: f.id, status: s, comment: comment || undefined })

  return (
    <div
      ref={ref}
      data-finding={f.id}
      data-active={active}
      onClick={() => !active && onSelect()}
      className={cn(
        'rounded-xl bg-card p-3.5 text-sm shadow-card transition-shadow',
        active ? 'shadow-raised ring-[1.5px] ring-primary' : 'cursor-pointer hover:shadow-raised',
        status !== 'open' && !active && 'opacity-70',
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-xs font-medium tracking-tight">{f.id}</span>
        <SeverityBadge severity={f.severity} />
        <Badge variant="outline" title={t(`criteria.${f.criterion}.description`)}>
          {t(`criteria.${f.criterion}.title`)}
        </Badge>
        {f.source === 'rule' ? (
          <Badge variant="secondary" title={t('report.sourceRuleHint')}>
            <Ruler />
            {t('report.sourceRule')}
          </Badge>
        ) : (
          <Badge variant="secondary" title={t('report.sourceLlmHint')}>
            <Bot />
            {t('report.sourceLlm')}
          </Badge>
        )}
        {status !== 'open' && (
          <Badge variant={status === 'false_positive' ? 'warning' : 'success'} className="ml-auto">
            {t(`review.${status}`)}
          </Badge>
        )}
      </div>
      <p className="mt-2 font-medium">{f.title}</p>
      {(f.requirement_ids?.length ?? 0) > 0 && (
        <div className="mt-1 flex flex-wrap gap-1 text-xs text-muted-foreground">
          {t(f.scope === 'set' ? 'report.scopeSet' : 'report.scopeReq')}:
          {f.requirement_ids!.map((r) => (
            <button
              key={r}
              type="button"
              className="font-mono text-primary hover:underline"
              onClick={(e) => {
                e.stopPropagation()
                onRequirement?.(r)
              }}
            >
              {r}
            </button>
          ))}
        </div>
      )}

      {active && (
        <div className="mt-3 grid gap-3" onClick={(e) => e.stopPropagation()}>
          <p className="leading-relaxed text-muted-foreground">{f.explanation}</p>
          <div className="grid gap-1.5">
            {f.locations.map((loc, i) => (
              <button
                key={i}
                type="button"
                onClick={() => onSelect(i)}
                className="group rounded-lg border-l-2 border-primary/70 bg-muted px-2.5 py-1.5 text-left hover:bg-accent"
              >
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <MapPin className="size-3" />
                  {loc.section}
                  {loc.page ? ` · ${t('report.page', { page: loc.page })}` : ''}
                  {!loc.verified && (
                    <span className="ml-auto text-warning" title={t('report.unverifiedHint')}>
                      {t('report.unverified')}
                    </span>
                  )}
                </span>
                <span className="mt-0.5 block italic">«{loc.quote}»</span>
              </button>
            ))}
          </div>
          {f.suggestion && (
            <div className="rounded-md border border-success/40 bg-success/5 p-2.5">
              <div className="mb-1 flex items-center justify-between text-xs font-medium text-success">
                {t('report.suggestion')}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="size-6"
                  aria-label={t('common.copy')}
                  onClick={() => navigator.clipboard?.writeText(f.suggestion!).then(() => toast.success(t('common.copied')))}
                >
                  <Copy className="size-3.5" />
                </Button>
              </div>
              <p className="leading-relaxed">{f.suggestion}</p>
            </div>
          )}

          <div className="grid gap-2 border-t pt-3">
            <div className="flex flex-wrap gap-1" role="group" aria-label={t('review.label')}>
              {REVIEW_STATUSES.map((s) => {
                const Icon = STATUS_ICON[s]
                return (
                  <Button
                    key={s}
                    size="sm"
                    variant={status === s ? 'default' : 'outline'}
                    aria-pressed={status === s}
                    disabled={mut.isPending}
                    onClick={() => setStatus(s)}
                  >
                    <Icon />
                    {t(`review.${s}`)}
                  </Button>
                )
              })}
            </div>
            {editing ? (
              <div className="grid gap-2">
                <Textarea
                  autoFocus
                  rows={2}
                  value={comment}
                  placeholder={t('review.commentPlaceholder')}
                  onChange={(e) => setComment(e.target.value)}
                />
                <div className="flex justify-end gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                    {t('common.cancel')}
                  </Button>
                  <Button
                    size="sm"
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
                className="flex items-start gap-1.5 text-left text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setEditing(true)}
              >
                <MessageSquare className="mt-0.5 size-3.5 shrink-0" />
                {review?.comment || t('review.addComment')}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
})
