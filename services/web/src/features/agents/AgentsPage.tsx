// Страница «Агенты»: архитектура проверки — какие агенты есть, что делает каждый, что получает и кому передаёт,
// кто отвечает за какие критерии и как дефект проходит путь от находки до отчёта.
import { ArrowDown, BookOpen, Bot, Code2, Database, Gauge, Layers, MousePointerClick } from 'lucide-react'
import { Fragment, useRef, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useSearchParams } from 'react-router'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/ui/misc'
import { REQUIREMENT_CRITERIA, SET_CRITERIA } from '@/shared/criteria'
import { cn } from '@/shared/utils'
import { AGENTS, byId, FINDER_IDS, FLOW, inputsOf, LANES, outputsOf, PRINCIPLES, SPEED, type AgentDef, type AgentKind } from './model'

const KIND_COLOR: Record<AgentKind, string> = {
  llm: 'var(--accent-2)',
  code: 'var(--teal)',
  data: 'var(--primary)',
}

function KindIcon({ kind, className }: { kind: AgentKind; className?: string }) {
  const Icon = kind === 'llm' ? Bot : kind === 'code' ? Code2 : Database
  return <Icon className={cn('size-4 shrink-0', className)} style={{ color: KIND_COLOR[kind] }} aria-hidden />
}

export function AgentsPage() {
  const { t } = useTranslation()
  const [params, setParams] = useSearchParams()
  const selected = byId(params.get('agent') ?? '') ?? null
  const aside = useRef<HTMLElement>(null)
  const select = (id: string | null) => {
    setParams((p) => {
      const next = new URLSearchParams(p)
      if (id && id !== selected?.id) next.set('agent', id)
      else next.delete('agent')
      return next
    })
    // на узком экране панель агента — под схемой: прокручиваем к ней
    if (id && window.matchMedia && !window.matchMedia('(min-width: 1024px)').matches)
      requestAnimationFrame(() => aside.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }))
  }
  const name = (id: string) => t(`agentsPage.items.${id}.name`)

  // связанные с выбранным: от кого получает и кому передаёт
  const related = new Set(selected ? [...inputsOf(selected), ...outputsOf(selected.id)] : [])

  const stats: [string, number][] = [
    [t('agentsPage.stats.llm'), AGENTS.filter((a) => a.kind === 'llm').length],
    [t('agentsPage.stats.code'), AGENTS.filter((a) => a.kind === 'code').length],
    [t('agentsPage.stats.stages'), LANES.filter((l) => l.code).length],
    [t('agentsPage.stats.criteria'), REQUIREMENT_CRITERIA.length + SET_CRITERIA.length],
  ]

  const node = (a: AgentDef) => {
    const on = selected?.id === a.id
    const near = related.has(a.id)
    return (
      <button
        key={a.id}
        type="button"
        aria-pressed={on}
        onClick={() => select(a.id)}
        className={cn(
          'press flex min-w-0 cursor-pointer items-start gap-2.5 rounded-xl border bg-card px-3 py-2.5 text-left transition-[opacity,border-color,box-shadow]',
          'hover:border-foreground/30',
          on && 'border-foreground shadow-raised',
          near && !on && 'border-accent-2/60',
          selected && !on && !near && 'opacity-45',
        )}
        style={{ boxShadow: on ? undefined : `inset 3px 0 0 ${KIND_COLOR[a.kind]}` }}
      >
        <KindIcon kind={a.kind} className="mt-0.5" />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm leading-snug font-medium">{name(a.id)}</span>
          <span className="text-xs leading-snug text-muted-foreground">{t(`agentsPage.items.${a.id}.short`)}</span>
        </span>
      </button>
    )
  }

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow={t('agentsPage.eyebrow')}
        title={t('agentsPage.title')}
        description={t('agentsPage.subtitle')}
        actions={
          <Button asChild variant="outline" size="sm">
            <Link to="/knowledge">
              <BookOpen />
              {t('nav.knowledge')}
            </Link>
          </Button>
        }
      />

      <div className="-mt-4 grid grid-cols-2 overflow-hidden rounded-2xl bg-card shadow-card sm:grid-cols-4">
        {stats.map(([k, v]) => (
          <div key={k} className="flex flex-col gap-1 border-b p-4 sm:border-r sm:border-b-0 sm:last:border-r-0">
            <span className="label-mono">{k}</span>
            <span className="text-2xl font-medium tabular-nums">{v}</span>
          </div>
        ))}
      </div>

      <section aria-labelledby="agents-scheme" className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 rounded-2xl bg-card p-4 shadow-card sm:p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 id="agents-scheme" className="text-lg font-medium tracking-tight">
              {t('agentsPage.schemeTitle')}
            </h2>
            <Legend />
          </div>
          <ol className="flex flex-col" aria-label={t('agentsPage.schemeTitle')}>
            {LANES.map((lane, i) => {
              const agents = AGENTS.filter((a) => a.lane === lane.id)
              const reviewers = lane.id === 'checking_set'
              return (
                <Fragment key={lane.id}>
                  {i > 0 && (
                    <li aria-hidden className="flex h-6 items-center sm:pl-40">
                      <ArrowDown className="ml-6 size-4 text-muted-foreground/60" />
                    </li>
                  )}
                  <li className="grid gap-2 sm:grid-cols-[9.5rem_minmax(0,1fr)] sm:gap-4">
                    <div className="flex flex-row items-baseline gap-2 sm:flex-col sm:gap-0.5 sm:pt-2">
                      <span className="font-mono text-[0.6875rem] text-muted-foreground">{lane.code ?? '—'}</span>
                      <span className="text-sm font-medium">{t(`agentsPage.lanes.${lane.id}`)}</span>
                      {reviewers && (
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                          <Layers className="size-3" aria-hidden />
                          {t('agentsPage.parallel')}
                        </span>
                      )}
                    </div>
                    <div
                      className={cn(
                        reviewers
                          ? 'grid grid-cols-1 gap-2 rounded-2xl border border-dashed p-2 sm:grid-cols-2 xl:grid-cols-3'
                          : 'flex flex-wrap gap-2 [&>button]:w-full sm:[&>button]:w-60',
                      )}
                    >
                      {agents.map(node)}
                    </div>
                  </li>
                </Fragment>
              )
            })}
          </ol>
        </div>

        <aside ref={aside} className="min-w-0 scroll-mt-4 lg:sticky lg:top-4 lg:self-start" aria-label={t('agentsPage.details.title')}>
          {selected ? <Details agent={selected} onSelect={select} /> : <Placeholder />}
        </aside>
      </section>

      <section aria-labelledby="agents-principles" className="flex flex-col gap-4">
        <h2 id="agents-principles" className="text-lg font-medium tracking-tight">
          {t('agentsPage.principlesTitle')}
        </h2>
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {PRINCIPLES.map((p, i) => (
            <li key={p} className="flex flex-col gap-2 rounded-2xl bg-card p-4 shadow-card">
              <span className="font-mono text-[0.6875rem] text-muted-foreground">{String(i + 1).padStart(2, '0')}</span>
              <span className="font-medium">{t(`agentsPage.principles.${p}.title`)}</span>
              <span className="text-sm text-muted-foreground">{t(`agentsPage.principles.${p}.text`)}</span>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="agents-speed" className="flex flex-col gap-4">
        <div>
          <h2 id="agents-speed" className="text-lg font-medium tracking-tight">
            {t('agentsPage.speedTitle')}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('agentsPage.speedHint')}</p>
        </div>
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {SPEED.map((s) => (
            <li key={s} className="flex flex-col gap-2 rounded-2xl bg-card p-4 shadow-card">
              <Gauge className="size-4 text-accent-2" aria-hidden />
              <span className="font-medium">{t(`agentsPage.speed.${s}.title`)}</span>
              <span className="text-sm text-muted-foreground">{t(`agentsPage.speed.${s}.text`)}</span>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="agents-matrix" className="flex flex-col gap-4">
        <div>
          <h2 id="agents-matrix" className="text-lg font-medium tracking-tight">
            {t('agentsPage.matrixTitle')}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('agentsPage.matrixHint')}</p>
        </div>
        <Matrix selected={selected?.id ?? null} onSelect={select} />
      </section>

      <section aria-labelledby="agents-flow" className="flex flex-col gap-4 pb-6">
        <div>
          <h2 id="agents-flow" className="text-lg font-medium tracking-tight">
            {t('agentsPage.flowTitle')}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('agentsPage.flowHint')}</p>
        </div>
        <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {FLOW.map((s, i) => (
            <li key={s.id} className="relative flex flex-col gap-2 rounded-2xl bg-card p-4 shadow-card">
              <span className="flex size-6 items-center justify-center rounded-full bg-secondary font-mono text-[0.6875rem]">{i + 1}</span>
              <span className="font-medium">{t(`agentsPage.flow.${s.id}.title`)}</span>
              <span className="text-sm text-muted-foreground">{t(`agentsPage.flow.${s.id}.text`)}</span>
              <span className="mt-auto flex flex-wrap gap-1 pt-1">
                {s.agents.map((id) => (
                  <button
                    key={id}
                    type="button"
                    // все рецензенты — одной плашкой, откроет первого
                    onClick={() => select(id === 'reviewers' ? 'logic' : id)}
                    className="cursor-pointer rounded-full bg-secondary px-2 py-0.5 text-[0.6875rem] text-muted-foreground hover:text-foreground"
                  >
                    {id === 'reviewers' ? t('agentsPage.reviewersChip') : name(id)}
                  </button>
                ))}
              </span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  )
}

function Legend() {
  const { t } = useTranslation()
  return (
    <ul className="flex flex-wrap gap-3 text-xs text-muted-foreground">
      {(['llm', 'code', 'data'] as AgentKind[]).map((k) => (
        <li key={k} className="inline-flex items-center gap-1.5">
          <KindIcon kind={k} className="size-3.5" />
          {t(`agentsPage.kind.${k}`)}
        </li>
      ))}
    </ul>
  )
}

function Placeholder() {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-3 rounded-2xl bg-card p-5 shadow-card">
      <MousePointerClick className="size-5 text-muted-foreground" aria-hidden />
      <p className="font-medium">{t('agentsPage.details.pick')}</p>
      <p className="text-sm text-muted-foreground">{t('agentsPage.details.pickHint')}</p>
    </div>
  )
}

function Details({ agent, onSelect }: { agent: AgentDef; onSelect: (id: string) => void }) {
  const { t } = useTranslation()
  const k = `agentsPage.items.${agent.id}`
  const lane = LANES.find((l) => l.id === agent.lane)!
  const how = t(`${k}.how`).split('\n').filter(Boolean)
  const chips = (ids: string[]) =>
    ids.length ? (
      <span className="flex flex-wrap gap-1.5">
        {ids.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => onSelect(id)}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border bg-card px-2.5 py-1 text-xs hover:border-foreground/30"
          >
            <KindIcon kind={byId(id)!.kind} className="size-3" />
            {t(`agentsPage.items.${id}.name`)}
          </button>
        ))}
      </span>
    ) : (
      <span className="text-sm text-muted-foreground">—</span>
    )
  return (
    <article className="flex flex-col gap-4 rounded-2xl bg-card p-5 shadow-card" aria-labelledby="agent-title">
      <header className="flex flex-col gap-2">
        <span className="label-mono">
          {lane.code ? `${lane.code} · ` : ''}
          {t(`agentsPage.lanes.${lane.id}`)}
        </span>
        <h2 id="agent-title" className="text-xl font-medium tracking-tight">
          {t(`${k}.name`)}
        </h2>
        <span className="flex flex-wrap gap-1.5">
          <Badge variant="outline">
            <KindIcon kind={agent.kind} />
            {t(`agentsPage.kind.${agent.kind}`)}
          </Badge>
          {agent.parallel && <Badge variant="secondary">{t('agentsPage.parallel')}</Badge>}
        </span>
      </header>
      <p className="text-sm">{t(`${k}.role`)}</p>
      {agent.reviewer && <p className="rounded-xl bg-secondary p-3 text-xs text-muted-foreground">{t('agentsPage.reviewerNote')}</p>}
      <dl className="grid gap-3 text-sm">
        <Row label={t('agentsPage.details.input')}>{t(agent.reviewer ? 'agentsPage.reviewerInput' : `${k}.input`)}</Row>
        <Row label={t('agentsPage.details.output')}>{t(agent.reviewer ? 'agentsPage.reviewerOutput' : `${k}.output`)}</Row>
        <Row label={t('agentsPage.details.from')}>{chips(inputsOf(agent))}</Row>
        <Row label={t('agentsPage.details.to')}>{chips(outputsOf(agent.id))}</Row>
        {agent.criteria.length > 0 && (
          <Row label={t('agentsPage.details.criteria')}>
            <span className="flex flex-wrap gap-1.5">
              {agent.criteria.map((c) => (
                <Badge key={c} variant="secondary" title={t(`criteria.${c}.description`)}>
                  {t(`criteria.${c}.title`)}
                </Badge>
              ))}
            </span>
          </Row>
        )}
      </dl>
      <div className="flex flex-col gap-2">
        <span className="label-mono">{t('agentsPage.details.how')}</span>
        <ul className="flex list-disc flex-col gap-1.5 pl-4 text-sm text-muted-foreground marker:text-muted-foreground/50">
          {how.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>
      <div className="flex flex-col gap-1">
        <span className="label-mono">{t('agentsPage.details.code')}</span>
        <code className="font-mono text-xs break-words text-muted-foreground">{agent.fn}</code>
      </div>
      {agent.id === 'knowledge' && (
        <Button asChild variant="outline" size="sm" className="self-start">
          <Link to="/knowledge">
            <BookOpen />
            {t('agentsPage.details.openKb')}
          </Link>
        </Button>
      )}
    </article>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="label-mono">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  )
}

function Matrix({ selected, onSelect }: { selected: string | null; onSelect: (id: string) => void }) {
  const { t } = useTranslation()
  const finders = FINDER_IDS.map((id) => byId(id)!)
  const group = (title: string, list: typeof REQUIREMENT_CRITERIA) => (
    <>
      <tr>
        <th colSpan={finders.length + 1} scope="colgroup" className="bg-secondary/60 px-3 py-1.5 text-left label-mono">
          {title}
        </th>
      </tr>
      {list.map((c) => (
        <tr key={c} className="border-t">
          <th scope="row" className="px-3 py-1.5 text-left font-normal whitespace-nowrap" title={t(`criteria.${c}.description`)}>
            {t(`criteria.${c}.title`)}
          </th>
          {finders.map((a) => {
            const on = a.criteria.includes(c)
            return (
              <td key={a.id} className={cn('px-2 py-1.5 text-center', selected === a.id && 'bg-accent-2/10')}>
                {on ? (
                  <span
                    className="inline-block size-2.5 rounded-full"
                    style={{ background: KIND_COLOR[a.kind] }}
                    aria-label={`${t(`agentsPage.items.${a.id}.name`)}: ${t(`criteria.${c}.title`)}`}
                    role="img"
                  />
                ) : (
                  <span className="text-muted-foreground/30" aria-hidden>
                    ·
                  </span>
                )}
              </td>
            )
          })}
        </tr>
      ))}
    </>
  )
  return (
    <div className="overflow-x-auto rounded-2xl bg-card shadow-card">
      <table className="w-full min-w-[44rem] text-sm" aria-label={t('agentsPage.matrixTitle')}>
        <thead>
          <tr>
            <th className="px-3 py-2 text-left label-mono">{t('agentsPage.matrixCriterion')}</th>
            {finders.map((a) => (
              <th key={a.id} scope="col" className={cn('px-2 py-2 align-bottom', selected === a.id && 'bg-accent-2/10')}>
                <button
                  type="button"
                  onClick={() => onSelect(a.id)}
                  className="cursor-pointer text-xs font-medium leading-tight text-muted-foreground hover:text-foreground"
                >
                  {t(`agentsPage.items.${a.id}.name`)}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {group(t('agentsPage.matrixReq'), REQUIREMENT_CRITERIA)}
          {group(t('agentsPage.matrixSet'), SET_CRITERIA)}
        </tbody>
      </table>
    </div>
  )
}
