import { CheckCircle2, CircleDashed, Loader2, XCircle, Ban } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { RunStage, RunSummary, Severity } from '@/api/types'
import { isTerminal } from '@/api/types'
import { Badge, type BadgeVariant } from '@/components/ui/badge'
import { SEVERITIES } from '@/shared/criteria'

export function RunStatusBadge({ status }: { status: RunStage }) {
  const { t } = useTranslation()
  const map: Record<string, { v: BadgeVariant; icon: ReactNode }> = {
    done: { v: 'success', icon: <CheckCircle2 /> },
    failed: { v: 'destructive', icon: <XCircle /> },
    cancelled: { v: 'secondary', icon: <Ban /> },
    queued: { v: 'secondary', icon: <CircleDashed /> },
  }
  const m = map[status] ?? { v: 'default' as BadgeVariant, icon: <Loader2 className="animate-spin" /> }
  return (
    <Badge variant={isTerminal(status) || status === 'queued' ? m.v : 'outline'}>
      {m.icon}
      {t(`stage.${status}`)}
    </Badge>
  )
}

export function SeverityBadge({ severity, count }: { severity: Severity; count?: number }) {
  const { t } = useTranslation()
  return (
    <Badge variant={severity}>
      {count !== undefined && <span className="tabular-nums">{count}</span>}
      {t(`severity.${severity}`)}
    </Badge>
  )
}

export function SeverityCounts({ summary }: { summary?: RunSummary | null }) {
  if (!summary) return null
  return (
    <div className="flex flex-wrap gap-1">
      {SEVERITIES.map((s) => {
        const n = summary.by_severity?.[s] ?? 0
        return n > 0 ? <SeverityBadge key={s} severity={s} count={n} /> : null
      })}
    </div>
  )
}

export function ReadinessBadge({ ready, plain = false }: { ready?: boolean; plain?: boolean }) {
  const { t } = useTranslation()
  if (ready === undefined) return null
  const label = ready ? t('report.readyYes') : t('report.readyNo')
  if (plain) return <span className={ready ? 'text-sm font-semibold text-success' : 'text-sm font-semibold text-sev-critical'}>{label}</span>
  return <Badge variant={ready ? 'success' : 'destructive'}>{label}</Badge>
}
