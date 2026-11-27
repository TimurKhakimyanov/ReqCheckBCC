import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Finding, Severity } from '@/api/types'
import { SEVERITY_RANK } from '@/shared/criteria'
import { cn } from '@/shared/utils'
import { buildSegments, collectRanges, topSeverity } from './highlight'
import { findHeadings, renderDocument, type RenderMark } from './prettyText'
import { EYEBROW, SEV_TEXT } from './ui'

const esc = (s: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&'))
const PIN_GAP = 22

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

interface Pin {
  id: string
  loc: number
  top: number
  severity: Severity
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
  const scrollRef = useRef<HTMLDivElement>(null)
  const articleRef = useRef<HTMLElement>(null)
  const ranges = useMemo(() => collectRanges(text, findings), [text, findings])
  const segments = useMemo(() => {
    const extra = focusRange ? [{ ...focusRange, findingId: '__focus', locIndex: 0, severity: 'minor' as const }] : []
    return buildSegments(text, [...ranges, ...extra])
  }, [text, ranges, focusRange])
  const located = useMemo(() => new Set(ranges.map((r) => r.findingId)), [ranges])
  const byId = useMemo(() => new Map(findings.map((f) => [f.id, f])), [findings])

  // Оглавление: разделы документа и сколько дефектов (по первой цитате) в каждом.
  const sections = useMemo(() => {
    const all = findHeadings(text)
    const top = all.filter((h) => h.level === 1).length > 1 ? [1, 2] : [2, 3]
    const hs = all.filter((h) => top.includes(h.level))
    const firstAt = new Map<string, { start: number; severity: Severity }>()
    for (const r of ranges) {
      const cur = firstAt.get(r.findingId)
      if (!cur || r.start < cur.start) firstAt.set(r.findingId, { start: r.start, severity: r.severity })
    }
    return hs.map((h, i) => {
      const end = hs[i + 1]?.start ?? Infinity
      const inside = [...firstAt.values()].filter((x) => x.start >= h.start && x.start < end)
      const worst = inside.map((x) => x.severity).sort((a, b) => SEVERITY_RANK[a] - SEVERITY_RANK[b])[0]
      return { ...h, count: inside.length, worst }
    })
  }, [text, ranges])

  useEffect(() => {
    if (!shouldScroll || !scrollRef.current) return
    const root = scrollRef.current
    const target =
      (activeId && root.querySelector<HTMLElement>(`[data-loc~="${esc(`${activeId}:${activeLoc}`)}"]`)) ||
      (activeId && root.querySelector<HTMLElement>(`[data-ids~="${esc(activeId)}"]`)) ||
      root.querySelector<HTMLElement>('[data-focus="true"]')
    target?.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollNonce, focusRange])

  // Пометки на полях: по одной на дефект — на уровне его первой цитаты; наложения сдвигаются вниз.
  const [pins, setPins] = useState<Pin[]>([])
  const measure = useCallback(() => {
    const root = articleRef.current
    if (!root) return
    const base = root.getBoundingClientRect().top
    const first = new Map<string, { top: number; loc: number }>()
    root.querySelectorAll<HTMLElement>('mark.rc-hl[data-loc]').forEach((el) => {
      const top = el.getBoundingClientRect().top - base
      for (const tok of (el.dataset.loc ?? '').split(' ')) {
        const [id, li] = tok.split(':')
        const cur = first.get(id)
        if (!cur || top < cur.top) first.set(id, { top, loc: Number(li) || 0 })
      }
    })
    const list: Pin[] = [...first]
      .filter(([id]) => byId.has(id))
      .map(([id, v]) => ({ id, loc: v.loc, top: v.top, severity: byId.get(id)!.severity }))
      .sort((a, b) => a.top - b.top || SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.id.localeCompare(b.id))
    let last = -Infinity
    for (const p of list) {
      p.top = Math.max(Math.round(p.top), last + PIN_GAP)
      last = p.top
    }
    setPins((prev) => (JSON.stringify(prev) === JSON.stringify(list) ? prev : list))
  }, [byId])

  useLayoutEffect(() => {
    measure()
    const root = articleRef.current
    const ro = typeof ResizeObserver !== 'undefined' && root ? new ResizeObserver(() => measure()) : null
    if (ro && root) ro.observe(root)
    document.fonts?.ready?.then(() => measure()).catch(() => {})
    return () => ro?.disconnect()
  }, [segments, measure])

  const renderMark = useCallback<RenderMark>(
    (piece, key, children) => {
      const real = piece.ranges.filter((r) => r.findingId !== '__focus')
      const isFocus = real.length !== piece.ranges.length
      if (!real.length)
        return (
          <mark key={key} data-focus="true" className="rc-focus">
            {children}
          </mark>
        )
      const ids = [...new Set(real.map((r) => r.findingId))]
      const active = !!activeId && ids.includes(activeId)
      return (
        <mark
          key={key}
          className="rc-hl"
          data-severity={topSeverity(real)}
          data-active={active}
          data-focus={isFocus || undefined}
          data-ids={ids.join(' ')}
          data-loc={real.filter((r) => r.start === piece.start).map((r) => `${r.findingId}:${r.locIndex}`).join(' ') || undefined}
          title={ids.map((id) => `${id} · ${byId.get(id)?.title ?? ''}`).join('\n')}
          onClick={() => {
            // повторный клик по месту с несколькими дефектами перебирает их по очереди
            const idx = active ? (ids.indexOf(activeId!) + 1) % ids.length : 0
            const r = real.find((x) => x.findingId === ids[idx])!
            onSelect(ids[idx], r.locIndex)
          }}
        >
          {children}
        </mark>
      )
    },
    [activeId, byId, onSelect],
  )

  const blocks = useMemo(() => renderDocument(text, segments, renderMark), [text, segments, renderMark])
  const unlocated = findings.filter((f) => !located.has(f.id))

  const goToHeading = (start: number) => {
    scrollRef.current?.querySelector<HTMLElement>(`[data-h="${start}"]`)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto bg-card" data-testid="document-viewer">
      {(sections.length > 0 || unlocated.length > 0) && (
        <div className="sticky top-0 z-10 border-b bg-card/95 backdrop-blur">
          {sections.length > 0 && (
            <nav aria-label={t('report.docSections')} className="flex items-center gap-2 overflow-x-auto px-4 py-2.5 [scrollbar-width:thin] sm:px-6">
              <span className={cn(EYEBROW, 'mr-1 shrink-0')}>{t('report.sections')}</span>
              {sections.map((h) => (
                <button
                  key={h.start}
                  type="button"
                  onClick={() => goToHeading(h.start)}
                  className="rc-focusable shrink-0 cursor-pointer border px-2 py-1 text-xs whitespace-nowrap transition-colors hover:bg-secondary"
                  title={h.title}
                >
                  <span className="inline-block max-w-56 truncate align-bottom">{h.title}</span>
                  {h.count > 0 && <span className={cn('ml-1 font-mono', h.worst && SEV_TEXT[h.worst])}>·{h.count}</span>}
                </button>
              ))}
            </nav>
          )}
          {unlocated.length > 0 && (
            <div className="border-t px-4 py-2 text-xs text-muted-foreground sm:px-6">
              {t('report.unlocated', { count: unlocated.length, ids: unlocated.map((f) => f.id).join(', ') })}
            </div>
          )}
        </div>
      )}
      <article
        ref={articleRef}
        className="relative mx-auto max-w-[880px] py-7 pr-4 pb-12 pl-[64px] text-[0.9375rem] leading-[1.75] break-words text-foreground/90 sm:pr-8 sm:pl-[84px]"
      >
        {pins.map((p) => (
          <button
            key={p.id}
            type="button"
            className="rc-pin absolute left-2 sm:left-5"
            style={{ top: p.top + 3 }}
            data-severity={p.severity}
            data-active={p.id === activeId}
            aria-label={`${p.id} · ${byId.get(p.id)?.title ?? ''}`}
            onClick={() => onSelect(p.id, p.loc)}
          >
            {p.id}
          </button>
        ))}
        {blocks}
      </article>
    </div>
  )
})
