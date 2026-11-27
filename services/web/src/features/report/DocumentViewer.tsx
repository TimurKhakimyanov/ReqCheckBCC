import { memo, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { Finding } from '@/api/types'
import { buildSegments, collectRanges, topSeverity } from './highlight'

const esc = (s: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&'))

interface Props {
  text: string
  findings: Finding[]
  activeId: string | null
  activeLoc: number
  /** Меняется при каждом выборе в списке — сигнал прокрутить к цитате. */
  scrollNonce: number
  shouldScroll: boolean
  onSelect: (findingId: string, locIndex: number) => void
  /** Временная подсветка места требования (из таблицы нарезки). */
  focusRange?: { start: number; end: number } | null
}

export const DocumentViewer = memo(function DocumentViewer({
  text,
  findings,
  activeId,
  activeLoc,
  scrollNonce,
  shouldScroll,
  onSelect,
  focusRange,
}: Props) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)
  const ranges = useMemo(() => collectRanges(text, findings), [text, findings])
  const segments = useMemo(() => {
    const extra = focusRange ? [{ ...focusRange, findingId: '__focus', locIndex: 0, severity: 'minor' as const }] : []
    return buildSegments(text, [...ranges, ...extra])
  }, [text, ranges, focusRange])
  const located = useMemo(() => new Set(ranges.map((r) => r.findingId)), [ranges])

  useEffect(() => {
    if (!shouldScroll || !ref.current) return
    const target =
      (activeId && ref.current.querySelector<HTMLElement>(`[data-loc~="${esc(`${activeId}:${activeLoc}`)}"]`)) ||
      (activeId && ref.current.querySelector<HTMLElement>(`[data-ids~="${esc(activeId)}"]`)) ||
      ref.current.querySelector<HTMLElement>('[data-focus="true"]')
    target?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollNonce, focusRange])

  const unlocated = findings.filter((f) => !located.has(f.id))

  return (
    <div ref={ref} className="h-full overflow-y-auto" data-testid="document-viewer">
      {unlocated.length > 0 && (
        <div className="sticky top-0 z-10 border-b bg-card/95 px-6 py-2 text-xs text-muted-foreground backdrop-blur">
          {t('report.unlocated', { count: unlocated.length, ids: unlocated.map((f) => f.id).join(', ') })}
        </div>
      )}
      <div className="px-6 py-5 text-[0.9rem] leading-7 break-words whitespace-pre-wrap">
        {segments.map((s) => {
          if (!s.ranges.length) return <span key={s.start}>{s.text}</span>
          const isFocus = s.ranges.some((r) => r.findingId === '__focus')
          const real = s.ranges.filter((r) => r.findingId !== '__focus')
          if (!real.length)
            return (
              <mark key={s.start} data-focus="true" className="rounded-sm bg-accent text-inherit ring-2 ring-primary/50">
                {s.text}
              </mark>
            )
          const ids = [...new Set(real.map((r) => r.findingId))]
          const active = !!activeId && ids.includes(activeId)
          const first = real.find((r) => r.start === s.start)
          return (
            <mark
              key={s.start}
              className="rc-hl"
              data-severity={topSeverity(real)}
              data-active={active}
              data-focus={isFocus || undefined}
              data-ids={ids.join(' ')}
              data-loc={real.filter((r) => r.start === s.start).map((r) => `${r.findingId}:${r.locIndex}`).join(' ') || undefined}
              title={ids.join(', ')}
              onClick={() => {
                // повторный клик по месту с несколькими дефектами перебирает их по очереди
                const idx = active ? (ids.indexOf(activeId!) + 1) % ids.length : 0
                const r = real.find((x) => x.findingId === ids[idx])!
                onSelect(ids[idx], r.locIndex)
              }}
            >
              {first && first.findingId === ids[0] && <sup className="mr-0.5 text-[0.6rem] font-semibold opacity-70 select-none">{ids[0]}</sup>}
              {s.text}
            </mark>
          )
        })}
      </div>
    </div>
  )
})
