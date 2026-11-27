import { ArrowDown, ArrowUp, FilterX, Search, X } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { Criterion, Finding, ReviewStatus, Severity } from '@/api/types'
import { REVIEW_STATUSES } from '@/api/types'
import { NativeSelect } from '@/components/ui/input'
import { EmptyState } from '@/components/ui/misc'
import { ALL_CRITERIA, SEVERITIES } from '@/shared/criteria'
import { cn } from '@/shared/utils'
import { useReport } from './context'
import { DocumentViewer } from './DocumentViewer'
import { FindingCard } from './FindingCard'
import { isFiltered, type FindingFilters, EMPTY_FILTERS } from './filters'
import { collectRanges } from './highlight'
import { EYEBROW, SEV_BORDER, SEV_TINT, SevSquare } from './ui'

export const SEV_DOT = { critical: 'bg-sev-critical', major: 'bg-sev-major', minor: 'bg-sev-minor' }

export type Grouping = 'severity' | 'document'

interface Props {
  visible: Finding[]
  filters: FindingFilters
  setFilters: (f: FindingFilters) => void
  group: Grouping
  setGroup: (g: Grouping) => void
  focusRange: { start: number; end: number } | null
}

/** Раздел «Дефекты»: фильтры сверху, текст документа с пометками слева, список дефектов справа. */
export function FindingsWorkspace({ visible, filters, setFilters, group, setGroup, focusRange }: Props) {
  const { t } = useTranslation()
  const { report, selection, select } = useReport()
  return (
    <div className="flex min-h-0 flex-col lg:h-full">
      <FindingsToolbar filters={filters} setFilters={setFilters} group={group} setGroup={setGroup} />
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <section aria-label={t('report.docText')} className="h-[70vh] min-h-0 min-w-0 border-b lg:h-auto lg:flex-1 lg:border-r lg:border-b-0">
          <DocumentViewer
            text={report.document.text}
            findings={visible}
            activeId={selection.findingId}
            activeLoc={selection.locIndex}
            scrollNonce={selection.nonce}
            shouldScroll={selection.origin !== 'doc'}
            onSelect={(id, locIndex) => select(id, { locIndex, origin: 'doc' })}
            focusRange={focusRange}
          />
        </section>
        <aside aria-label={t('report.findingsList')} className="flex h-[80vh] min-h-0 flex-col lg:h-auto lg:w-[360px] lg:shrink-0 xl:w-[420px] 2xl:w-[460px]">
          <FindingsList visible={visible} group={group} />
        </aside>
      </div>
    </div>
  )
}

function FindingsToolbar({
  filters,
  setFilters,
  group,
  setGroup,
}: Pick<Props, 'filters' | 'setFilters' | 'group' | 'setGroup'>) {
  const { t } = useTranslation()
  const { report } = useReport()
  const critId = useId()
  const statusId = useId()
  const counts = useMemo(() => {
    const c = { critical: 0, major: 0, minor: 0 }
    report.findings.forEach((f) => c[f.severity]++)
    return c
  }, [report.findings])
  const usedCriteria = useMemo(() => ALL_CRITERIA.filter((c) => report.findings.some((f) => f.criterion === c)), [report.findings])

  const toggleSev = (s: Severity) =>
    setFilters({
      ...filters,
      severities: filters.severities.includes(s) ? filters.severities.filter((x) => x !== s) : [...filters.severities, s],
    })

  const selectCls = 'h-9 w-auto rounded-none bg-card text-[0.8125rem] shadow-none'
  return (
    <div role="group" aria-label={t('report.filters')} className="flex flex-wrap items-center gap-2 border-b bg-card px-4 py-3 sm:px-5">
      {SEVERITIES.map((s) => {
        const on = filters.severities.includes(s)
        return (
          <button
            key={s}
            type="button"
            aria-pressed={on}
            onClick={() => toggleSev(s)}
            className={cn(
              'rc-focusable inline-flex min-h-9 cursor-pointer items-center gap-2 border px-3 text-[0.8125rem] transition-colors',
              on ? cn(SEV_BORDER[s], SEV_TINT[s]) : 'border-input bg-card hover:border-foreground/40',
            )}
          >
            <SevSquare severity={s} />
            {t(`severity.${s}`)}
            <span className="font-mono text-muted-foreground">{counts[s]}</span>
          </button>
        )
      })}
      <label className="flex min-h-9 min-w-0 flex-[1_1_200px] items-center gap-2 border border-input bg-card px-2.5 focus-within:border-foreground/50">
        <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="sr-only">{t('report.searchFindings')}</span>
        <input
          type="search"
          className="min-w-0 flex-1 bg-transparent text-[0.8125rem] outline-none placeholder:text-muted-foreground/80"
          placeholder={t('report.searchPlaceholder')}
          value={filters.q}
          onChange={(e) => setFilters({ ...filters, q: e.target.value })}
        />
      </label>
      <span className="flex items-center gap-1.5">
        <label htmlFor={critId} className="text-xs text-muted-foreground">
          {t('report.criterion')}
        </label>
        <NativeSelect
          id={critId}
          className={selectCls}
          value={filters.criterion}
          onChange={(e) => setFilters({ ...filters, criterion: e.target.value as Criterion | '' })}
        >
          <option value="">{t('report.allCriteria')}</option>
          {usedCriteria.map((c) => (
            <option key={c} value={c}>
              {t(`criteria.${c}.title`)}
            </option>
          ))}
        </NativeSelect>
      </span>
      <span className="flex items-center gap-1.5">
        <label htmlFor={statusId} className="text-xs text-muted-foreground">
          {t('report.status')}
        </label>
        <NativeSelect
          id={statusId}
          className={selectCls}
          value={filters.status}
          onChange={(e) => setFilters({ ...filters, status: e.target.value as ReviewStatus | '' })}
        >
          <option value="">{t('report.allStatuses')}</option>
          {REVIEW_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s === 'open' ? t('report.notReviewedPl') : t(`review.${s}`)}
            </option>
          ))}
        </NativeSelect>
      </span>
      <div role="group" aria-label={t('report.groupBy')} className="flex border border-input">
        {(['severity', 'document'] as Grouping[]).map((g) => (
          <button
            key={g}
            type="button"
            aria-pressed={group === g}
            onClick={() => setGroup(g)}
            className={cn(
              'rc-focusable min-h-[34px] cursor-pointer px-3 font-mono text-xs transition-colors',
              group === g ? 'bg-foreground text-background' : 'bg-card hover:bg-secondary',
            )}
          >
            {t(g === 'severity' ? 'report.groupSeverity' : 'report.groupDocument')}
          </button>
        ))}
      </div>
      {filters.requirement && (
        <button
          type="button"
          onClick={() => setFilters({ ...filters, requirement: '' })}
          className="rc-focusable inline-flex min-h-9 cursor-pointer items-center gap-1.5 border border-foreground bg-secondary px-2.5 font-mono text-xs"
          aria-label={t('report.clearRequirement', { id: filters.requirement })}
        >
          {filters.requirement}
          <X className="size-3" />
        </button>
      )}
      {isFiltered(filters) && (
        <button
          type="button"
          onClick={() => setFilters(EMPTY_FILTERS)}
          className="rc-focusable inline-flex min-h-9 cursor-pointer items-center gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
        >
          <FilterX className="size-3.5" aria-hidden />
          {t('report.resetFilters')}
        </button>
      )}
    </div>
  )
}

interface Group {
  key: string
  title: string
  severity?: Severity
  items: Finding[]
}

function FindingsList({ visible, group }: { visible: Finding[]; group: Grouping }) {
  const { t } = useTranslation()
  const { report, reviews, selection, select, runId, goToRequirement } = useReport()
  const cards = useRef<Record<string, HTMLElement | null>>({})

  const sourceIds = useMemo(() => new Map(report.requirements.map((r) => [r.id, r.source_id])), [report.requirements])
  const where = (f: Finding) => {
    const reqs = f.requirement_ids ?? []
    if (reqs.length) return [...reqs.map((r) => sourceIds.get(r)).filter(Boolean), ...reqs].join(' · ')
    return f.locations[0]?.section ?? ''
  }

  const groups = useMemo<Group[]>(() => {
    if (group === 'severity')
      return SEVERITIES.map((s) => ({ key: s, title: t(`report.sevGroup.${s}`), severity: s, items: visible.filter((f) => f.severity === s) })).filter(
        (g) => g.items.length,
      )
    // по документу: порядок первой цитаты в тексте, группы — разделы
    const first = new Map<string, number>()
    for (const r of collectRanges(report.document.text, visible)) first.set(r.findingId, Math.min(first.get(r.findingId) ?? Infinity, r.start))
    const sorted = [...visible].sort((a, b) => (first.get(a.id) ?? Infinity) - (first.get(b.id) ?? Infinity) || a.id.localeCompare(b.id))
    const out: Group[] = []
    for (const f of sorted) {
      const title = f.locations[0]?.section || t('report.noSection')
      const last = out[out.length - 1]
      if (last && last.title === title) last.items.push(f)
      else out.push({ key: `${out.length}-${title}`, title, items: [f] })
    }
    return out
  }, [group, visible, report.document.text, t])
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups])

  // Выбор из текста или стрелками — прокрутить список к карточке.
  useEffect(() => {
    if (!selection.findingId || selection.origin === 'list') return
    cards.current[selection.findingId]?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' })
  }, [selection])

  const step = (d: 1 | -1) => {
    if (!flat.length) return
    const i = flat.findIndex((f) => f.id === selection.findingId)
    const next = i < 0 ? (d > 0 ? 0 : flat.length - 1) : Math.max(0, Math.min(flat.length - 1, i + d))
    select(flat[next].id, { origin: 'other' })
  }
  const onKeyDown = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement).tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      step(e.key === 'ArrowDown' ? 1 : -1)
    }
  }

  const navBtn = 'rc-focusable inline-flex size-8 cursor-pointer items-center justify-center border border-input bg-card transition-colors hover:border-foreground/40 disabled:cursor-default disabled:opacity-40'
  return (
    <>
      <div className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-2.5 text-[0.8125rem]">
        <span>{t('report.shown', { shown: visible.length, total: report.findings.length })}</span>
        <span className="flex gap-1.5">
          <button type="button" className={navBtn} onClick={() => step(-1)} disabled={!flat.length} aria-label={t('report.prevFinding')} title={t('report.prevFinding')}>
            <ArrowUp className="size-3.5" />
          </button>
          <button type="button" className={navBtn} onClick={() => step(1)} disabled={!flat.length} aria-label={t('report.nextFinding')} title={t('report.nextFinding')}>
            <ArrowDown className="size-3.5" />
          </button>
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-3.5 pb-6" data-testid="findings-list" onKeyDown={onKeyDown}>
        {visible.length === 0 ? (
          <EmptyState title={report.findings.length ? t('report.noMatches') : t('report.noFindings')} />
        ) : (
          <div className="flex flex-col gap-4">
            {groups.map((g) => (
              <section key={g.key} className="flex flex-col gap-2">
                <h3 className={cn(EYEBROW, 'flex items-center gap-2')}>
                  {g.severity && <SevSquare severity={g.severity} />}
                  <span className="truncate" title={g.title}>
                    {g.title}
                  </span>
                  <span className="shrink-0">· {g.items.length}</span>
                </h3>
                {g.items.map((f) => (
                  <FindingCard
                    key={f.id}
                    ref={(el) => {
                      cards.current[f.id] = el
                    }}
                    finding={f}
                    review={reviews[f.id]}
                    runId={runId}
                    active={selection.findingId === f.id}
                    where={where(f)}
                    onSelect={(locIndex) => select(f.id, { locIndex, origin: 'list' })}
                    onCollapse={() => select(null, { origin: 'list' })}
                    onRequirement={goToRequirement}
                  />
                ))}
              </section>
            ))}
          </div>
        )}
      </div>
    </>
  )
}
