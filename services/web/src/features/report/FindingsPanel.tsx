import { ArrowDown, ArrowUp, FilterX, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { Criterion, Finding, ReviewStatus } from '@/api/types'
import { REVIEW_STATUSES } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Input, NativeSelect } from '@/components/ui/input'
import { EmptyState } from '@/components/ui/misc'
import { ALL_CRITERIA, SEVERITIES } from '@/shared/criteria'
import { cn } from '@/shared/utils'
import { useReport } from './context'
import { FindingCard } from './FindingCard'
import { isFiltered, type FindingFilters, EMPTY_FILTERS } from './filters'
import { collectRanges } from './highlight'

type Grouping = 'severity' | 'document'
interface Group {
  key: string
  title: string
  items: Finding[]
}

const SEV_ON = {
  critical: 'bg-sev-critical-bg text-sev-critical',
  major: 'bg-sev-major-bg text-sev-major',
  minor: 'bg-sev-minor-bg text-sev-minor',
}
export const SEV_DOT = { critical: 'bg-sev-critical', major: 'bg-sev-major', minor: 'bg-sev-minor' }

interface Props {
  visible: Finding[]
  filters: FindingFilters
  setFilters: (f: FindingFilters) => void
}

export function FindingsPanel({ visible, filters, setFilters }: Props) {
  const { t } = useTranslation()
  const { report, reviews, selection, select, runId, goToRequirement } = useReport()
  const listRef = useRef<HTMLDivElement>(null)
  const cards = useRef<Record<string, HTMLDivElement | null>>({})

  const counts = useMemo(() => {
    const c = { critical: 0, major: 0, minor: 0 }
    report.findings.forEach((f) => c[f.severity]++)
    return c
  }, [report.findings])
  const usedCriteria = useMemo(() => ALL_CRITERIA.filter((c) => report.findings.some((f) => f.criterion === c)), [report.findings])
  const [group, setGroup] = useState<Grouping>('severity')

  // Группы: по серьёзности или по порядку в документе (разделы по первой цитате).
  const groups = useMemo<Group[]>(() => {
    if (group === 'severity')
      return SEVERITIES.map((s) => ({ key: s, title: t(`severity.${s}`), items: visible.filter((f) => f.severity === s) })).filter(
        (g) => g.items.length,
      )
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

  // ↑↓ — к предыдущему / следующему дефекту в порядке списка
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

  // Выбор из текста документа — прокрутить список к карточке.
  useEffect(() => {
    if (!selection.findingId || selection.origin === 'list') return
    const el = cards.current[selection.findingId]
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [selection])

  const toggleSev = (s: (typeof SEVERITIES)[number]) =>
    setFilters({
      ...filters,
      severities: filters.severities.includes(s) ? filters.severities.filter((x) => x !== s) : [...filters.severities, s],
    })

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="grid gap-2.5 border-b p-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {SEVERITIES.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={filters.severities.includes(s)}
              onClick={() => toggleSev(s)}
              className={cn(
                'press inline-flex min-h-8 cursor-pointer items-center gap-1.5 rounded-full px-3 text-xs font-medium transition-colors',
                filters.severities.includes(s) ? SEV_ON[s] : 'bg-secondary text-muted-foreground hover:bg-accent',
              )}
            >
              <span className={cn('size-2 rounded-full', SEV_DOT[s])} />
              {t(`severity.${s}`)}
              <span className="tabular-nums opacity-70">{counts[s]}</span>
            </button>
          ))}
          {isFiltered(filters) && (
            <Button variant="ghost" size="sm" className="ml-auto h-7" onClick={() => setFilters(EMPTY_FILTERS)}>
              <FilterX />
              {t('report.resetFilters')}
            </Button>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <NativeSelect
            aria-label={t('report.criterion')}
            className="h-9 rounded-full border-0 bg-secondary px-3 text-xs shadow-none"
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
          <NativeSelect
            aria-label={t('report.status')}
            className="h-9 rounded-full border-0 bg-secondary px-3 text-xs shadow-none"
            value={filters.status}
            onChange={(e) => setFilters({ ...filters, status: e.target.value as ReviewStatus | '' })}
          >
            <option value="">{t('report.allStatuses')}</option>
            {REVIEW_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`review.${s}`)}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute top-2.5 left-3 size-4 text-muted-foreground" />
            <Input
              className="h-9 rounded-full border-0 bg-secondary pl-9 text-xs shadow-none"
              placeholder={t('report.searchFindings')}
              value={filters.q}
              onChange={(e) => setFilters({ ...filters, q: e.target.value })}
            />
          </div>
          {filters.requirement && (
            <Button variant="secondary" size="sm" className="h-8" onClick={() => setFilters({ ...filters, requirement: '' })}>
              {filters.requirement} ×
            </Button>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>{t('report.shown', { shown: visible.length, total: report.findings.length })}</span>
          <span className="flex items-center gap-1.5">
            <span role="group" aria-label={t('report.groupBy')} className="inline-flex rounded-full bg-secondary p-0.5">
              {(['severity', 'document'] as const).map((g) => (
                <button
                  key={g}
                  type="button"
                  aria-pressed={group === g}
                  onClick={() => setGroup(g)}
                  className={cn(
                    'min-h-7 cursor-pointer rounded-full px-2.5 transition-colors',
                    group === g ? 'bg-card text-foreground shadow-card' : 'hover:text-foreground',
                  )}
                >
                  {t(g === 'severity' ? 'report.groupSeverity' : 'report.groupDocument')}
                </button>
              ))}
            </span>
            <Button variant="ghost" size="icon-sm" onClick={() => step(-1)} disabled={!flat.length} aria-label={t('report.prevFinding')} title={t('report.prevFinding')}>
              <ArrowUp />
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={() => step(1)} disabled={!flat.length} aria-label={t('report.nextFinding')} title={t('report.nextFinding')}>
              <ArrowDown />
            </Button>
          </span>
        </div>
      </div>
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto bg-background/60 p-3" data-testid="findings-list" onKeyDown={onKeyDown}>
        {visible.length === 0 ? (
          <EmptyState title={report.findings.length ? t('report.noMatches') : t('report.noFindings')} />
        ) : (
          <div className="grid gap-4">
            {groups.map((g) => (
              <section key={g.key} className="grid gap-2">
                <h3 className="label-mono flex items-center gap-2 px-1">
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
                    onSelect={(locIndex) => select(f.id, { locIndex, origin: 'list' })}
                    onRequirement={goToRequirement}
                  />
                ))}
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
