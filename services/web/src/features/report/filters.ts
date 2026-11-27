import type { Criterion, Finding, FindingReview, ReviewStatus, Severity } from '@/api/types'
import { SEVERITY_RANK } from '@/shared/criteria'

export interface FindingFilters {
  severities: Severity[] // пусто = все
  criterion: Criterion | ''
  status: ReviewStatus | ''
  requirement: string
  q: string
}

export const EMPTY_FILTERS: FindingFilters = { severities: [], criterion: '', status: '', requirement: '', q: '' }

export function filterFindings(findings: Finding[], reviews: Record<string, FindingReview>, f: FindingFilters): Finding[] {
  const q = f.q.trim().toLowerCase()
  return findings
    .filter((x) => !f.severities.length || f.severities.includes(x.severity))
    .filter((x) => !f.criterion || x.criterion === f.criterion)
    .filter((x) => !f.status || (reviews[x.id]?.status ?? 'open') === f.status)
    .filter((x) => !f.requirement || (x.requirement_ids ?? []).includes(f.requirement))
    .filter(
      (x) =>
        !q ||
        [x.id, x.title, x.explanation, x.suggestion ?? '', ...x.locations.map((l) => l.quote)].some((s) =>
          s.toLowerCase().includes(q),
        ),
    )
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.id.localeCompare(b.id))
}

export function isFiltered(f: FindingFilters) {
  return !!(f.severities.length || f.criterion || f.status || f.requirement || f.q)
}
