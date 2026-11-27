import { createContext, useContext } from 'react'
import type { Finding, FindingReview, Report, Run } from '@/api/types'

export type ReportTab = 'findings' | 'summary' | 'questions' | 'requirements' | 'matrix' | 'set' | 'checklist' | 'passport'

export interface Selection {
  findingId: string | null
  locIndex: number
  /** Счётчик: каждый новый выбор заново прокручивает даже к тому же месту. */
  nonce: number
  /** Откуда выбрали: из текста — прокрутить список; из списка — прокрутить текст. */
  origin: 'doc' | 'list' | 'other'
}

export interface ReportCtx {
  runId: string
  /** Прогон отчёта: документ, провайдер, модель и параметры — для перепроверки с ответами автора */
  run: Run
  report: Report
  findingsById: Record<string, Finding>
  reviews: Record<string, FindingReview>
  selection: Selection
  select: (findingId: string | null, opts?: { locIndex?: number; origin?: Selection['origin'] }) => void
  /** Перейти к дефекту из любой вкладки: открыть «Дефекты» и выделить. */
  goToFinding: (findingId: string) => void
  /** Показать место требования в тексте. */
  goToRequirement: (reqId: string) => void
  /** Открыть «Дефекты» с фильтром по требованию. */
  showRequirementFindings: (reqId: string) => void
  setTab: (t: ReportTab) => void
}

export const ReportContext = createContext<ReportCtx | null>(null)

export function useReport() {
  const ctx = useContext(ReportContext)
  if (!ctx) throw new Error('useReport outside ReportContext')
  return ctx
}
