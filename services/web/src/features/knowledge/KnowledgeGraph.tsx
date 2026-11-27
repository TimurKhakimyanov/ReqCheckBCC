// Граф базы знаний: заметки, папки и упомянутые критерии. Раскладка — простая силовая модель на SVG
// (отталкивание, пружины по рёбрам, притяжение к центру), без внешних библиотек. Колесо — масштаб,
// перетаскивание фона — сдвиг, перетаскивание узла — закрепить в новом месте, клик по заметке — открыть.
import { Maximize2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent, type WheelEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { KnowledgeGraph, KnowledgeGraphNode } from '@/api/types'
import { Button } from '@/components/ui/button'
import { cn } from '@/shared/utils'

/** Цвет верхней папки — порядок фиксирован, цвет следует за папкой, а не за её местом в списке. */
export const FOLDER_COLORS = ['#D9611A', '#3F5FD6', '#12897D', '#8A7310', '#9B4DCA', '#C2185B', '#5F6B7A']
export const topFolder = (f: string) => f.split('/')[0] ?? ''

interface P {
  x: number
  y: number
  vx: number
  vy: number
  fixed?: boolean
}

// в тестовом окружении requestAnimationFrame может не быть
const nextFrame = (cb: () => void): number =>
  typeof requestAnimationFrame === 'function' ? requestAnimationFrame(cb) : (setTimeout(cb, 16) as unknown as number)
const cancelFrame = (id: number) => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(id) : clearTimeout(id))

const W = 1000
const H = 700
const REST: Record<string, number> = { folder: 90, link: 150, criterion: 180 }

export function KnowledgeGraphView({
  graph,
  selected,
  onOpen,
  colorOf,
}: {
  graph: KnowledgeGraph
  selected: string | null
  onOpen: (id: string) => void
  colorOf: (folder: string) => string
}) {
  const { t } = useTranslation()
  const [showFolders, setShowFolders] = useState(true)
  const [showCriteria, setShowCriteria] = useState(true)
  const [hover, setHover] = useState<string | null>(null)
  const [view, setView] = useState({ x: 0, y: 0, k: 1 })
  const [, setTick] = useState(0)

  const nodes = useMemo(
    () => graph.nodes.filter((n) => (n.kind !== 'folder' || showFolders) && (n.kind !== 'criterion' || showCriteria)),
    [graph.nodes, showFolders, showCriteria],
  )
  const ids = useMemo(() => new Set(nodes.map((n) => n.id)), [nodes])
  const edges = useMemo(() => graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target)), [graph.edges, ids])

  // позиции живут в ref: симуляция меняет их каждый кадр, React перерисовывает по счётчику
  const pos = useRef(new Map<string, P>())
  const heat = useRef(1)
  useEffect(() => {
    const m = pos.current
    nodes.forEach((n, i) => {
      if (!m.has(n.id)) {
        const a = (i / Math.max(1, nodes.length)) * Math.PI * 2
        const r = n.kind === 'criterion' ? 300 : n.kind === 'folder' ? 120 : 220
        m.set(n.id, { x: W / 2 + Math.cos(a) * r, y: H / 2 + Math.sin(a) * r * 0.7, vx: 0, vy: 0 })
      }
    })
    heat.current = 1
    setTick((x) => x + 1) // начальные позиции видны сразу, до первого кадра симуляции
    let frame = 0
    let raf = 0
    const step = () => {
      const list = nodes.map((n) => [n, m.get(n.id)!] as const)
      const alpha = heat.current
      for (let a = 0; a < list.length; a++) {
        const pa = list[a][1]
        for (let b = a + 1; b < list.length; b++) {
          const pb = list[b][1]
          let dx = pa.x - pb.x
          let dy = pa.y - pb.y
          let d2 = dx * dx + dy * dy
          if (d2 < 1) {
            dx = Math.random() - 0.5
            dy = Math.random() - 0.5
            d2 = 1
          }
          const f = (4200 * alpha) / d2
          const d = Math.sqrt(d2)
          pa.vx += (dx / d) * f
          pa.vy += (dy / d) * f
          pb.vx -= (dx / d) * f
          pb.vy -= (dy / d) * f
        }
      }
      for (const e of edges) {
        const s = m.get(e.source)
        const tt = m.get(e.target)
        if (!s || !tt) continue
        const dx = tt.x - s.x
        const dy = tt.y - s.y
        const d = Math.max(1, Math.hypot(dx, dy))
        const f = ((d - REST[e.kind]) / d) * 0.04 * alpha
        s.vx += dx * f
        s.vy += dy * f
        tt.vx -= dx * f
        tt.vy -= dy * f
      }
      for (const [, p] of list) {
        if (p.fixed) {
          p.vx = p.vy = 0
          continue
        }
        p.vx += (W / 2 - p.x) * 0.004 * alpha
        p.vy += (H / 2 - p.y) * 0.004 * alpha
        p.vx *= 0.6
        p.vy *= 0.6
        p.x += p.vx
        p.y += p.vy
      }
      heat.current = Math.max(0, heat.current * 0.985)
      frame++
      if (frame % 2 === 0) setTick((x) => x + 1)
      if (heat.current > 0.02) raf = nextFrame(step)
    }
    raf = nextFrame(step)
    return () => cancelFrame(raf)
  }, [nodes, edges])

  // соседи для подсветки
  const focus = hover ?? selected
  const near = useMemo(() => {
    const s = new Set<string>()
    if (!focus) return s
    s.add(focus)
    edges.forEach((e) => {
      if (e.source === focus) s.add(e.target)
      if (e.target === focus) s.add(e.source)
    })
    return s
  }, [focus, edges])

  // вид автоматически подгоняется под граф; пока тянут узел — подгонка заморожена, чтобы узел не «уплывал»
  const drag = useRef<{ id: string | null; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null)
  const fitRef = useRef({ s: 1, tx: 0, ty: 0 })
  if (!drag.current?.id) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    nodes.forEach((n) => {
      const p = pos.current.get(n.id)
      if (!p) return
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x)
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y)
    })
    if (Number.isFinite(minX)) {
      const pad = 80
      const s = Math.min(1.6, W / (Math.max(320, maxX - minX) + pad * 2), H / (Math.max(220, maxY - minY) + pad * 2))
      fitRef.current = { s, tx: W / 2 - (s * (minX + maxX)) / 2, ty: H / 2 - (s * (minY + maxY)) / 2 }
    }
  }
  const fit = fitRef.current

  const svg = useRef<SVGSVGElement>(null)
  const toWorld = (cx: number, cy: number) => {
    const r = svg.current!.getBoundingClientRect()
    const x = ((cx - r.left) / r.width) * W
    const y = ((cy - r.top) / r.height) * H
    const u = { x: (x - view.x) / view.k, y: (y - view.y) / view.k }
    return { x: (u.x - fit.tx) / fit.s, y: (u.y - fit.ty) / fit.s }
  }
  const onDown = (e: RPointerEvent, id: string | null) => {
    e.stopPropagation()
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    drag.current = { id, sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y, moved: false }
  }
  const onMove = (e: RPointerEvent) => {
    const d = drag.current
    if (!d) return
    if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 3) d.moved = true
    if (d.id) {
      const p = pos.current.get(d.id)
      if (!p) return
      const w = toWorld(e.clientX, e.clientY)
      p.x = w.x
      p.y = w.y
      p.fixed = true
      setTick((x) => x + 1)
    } else {
      const r = svg.current!.getBoundingClientRect()
      setView((v) => ({ ...v, x: d.ox + ((e.clientX - d.sx) / r.width) * W, y: d.oy + ((e.clientY - d.sy) / r.height) * H }))
    }
  }
  const onUp = (n?: KnowledgeGraphNode) => {
    const d = drag.current
    drag.current = null
    if (d && !d.moved && n?.kind === 'note') onOpen(n.id)
  }
  const onWheel = (e: WheelEvent) => {
    const r = svg.current!.getBoundingClientRect()
    const cx = ((e.clientX - r.left) / r.width) * W
    const cy = ((e.clientY - r.top) / r.height) * H
    const k = Math.min(3, Math.max(0.3, view.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12)))
    setView((v) => ({ k, x: cx - ((cx - v.x) * k) / v.k, y: cy - ((cy - v.y) * k) / v.k }))
  }

  const tops = [...new Set(graph.nodes.filter((n) => n.kind === 'note').map((n) => topFolder(n.folder)))].sort()
  const labelAll = nodes.length <= 40

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={showFolders} onChange={(e) => setShowFolders(e.target.checked)} className="accent-[var(--primary)]" />
          {t('wiki.graphFolders')}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={showCriteria} onChange={(e) => setShowCriteria(e.target.checked)} className="accent-[var(--primary)]" />
          {t('wiki.graphCriteria')}
        </label>
        <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setView({ x: 0, y: 0, k: 1 })}>
          <Maximize2 />
          {t('wiki.graphReset')}
        </Button>
      </div>
      <div className="relative min-h-[420px] flex-1 overflow-hidden bg-[radial-gradient(var(--dot)_1px,transparent_1.2px)] [background-size:16px_16px]">
        <svg
          ref={svg}
          viewBox={`0 0 ${W} ${H}`}
          className="absolute inset-0 size-full touch-none select-none"
          role="img"
          aria-label={t('wiki.graphAria', { notes: graph.nodes.filter((n) => n.kind === 'note').length, links: graph.edges.filter((e) => e.kind === 'link').length })}
          onPointerDown={(e) => onDown(e, null)}
          onPointerMove={onMove}
          onPointerUp={() => onUp()}
          onWheel={onWheel}
        >
          <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          <g transform={`translate(${fit.tx} ${fit.ty}) scale(${fit.s})`}>
            {edges.map((e, i) => {
              const s = pos.current.get(e.source)
              const tt = pos.current.get(e.target)
              if (!s || !tt) return null
              const lit = !focus || (near.has(e.source) && near.has(e.target))
              return (
                <line
                  key={i}
                  x1={s.x}
                  y1={s.y}
                  x2={tt.x}
                  y2={tt.y}
                  strokeWidth={e.kind === 'link' ? 1.6 : 1}
                  strokeDasharray={e.kind === 'criterion' ? '4 4' : undefined}
                  style={{
                    stroke: e.kind === 'link' ? 'var(--accent-2)' : 'var(--scene-edge)',
                    opacity: lit ? (e.kind === 'folder' ? 0.5 : 0.85) : 0.08,
                    transition: 'opacity .3s ease',
                  }}
                />
              )
            })}
            {nodes.map((n) => {
              const p = pos.current.get(n.id)
              if (!p) return null
              const lit = !focus || near.has(n.id)
              const sel = n.id === selected
              const color = n.kind === 'note' ? colorOf(n.folder) : n.kind === 'criterion' ? 'var(--teal)' : 'var(--muted-foreground)'
              const r = n.kind === 'note' ? Math.min(18, 6 + Math.sqrt(n.size) / 14) : n.kind === 'folder' ? 9 : 7 + Math.min(6, n.size)
              const showLabel = labelAll || sel || n.kind !== 'note' || (focus && near.has(n.id))
              return (
                <g
                  key={n.id}
                  transform={`translate(${p.x} ${p.y})`}
                  style={{ opacity: lit ? 1 : 0.2, transition: 'opacity .3s ease', cursor: n.kind === 'note' ? 'pointer' : 'grab' }}
                  onPointerDown={(e) => onDown(e, n.id)}
                  onPointerUp={(e) => {
                    e.stopPropagation()
                    onUp(n)
                  }}
                  onPointerEnter={() => setHover(n.id)}
                  onPointerLeave={() => setHover(null)}
                >
                  <title>{n.kind === 'folder' ? `${t('wiki.folder')}: ${n.folder}` : n.title}</title>
                  {n.kind === 'note' && (
                    <circle r={r} strokeWidth={sel ? 3 : 1.5} style={{ fill: color, stroke: sel ? 'var(--foreground)' : 'var(--background)' }} />
                  )}
                  {n.kind === 'folder' && (
                    <rect x={-r} y={-r} width={r * 2} height={r * 2} strokeWidth={1.5} style={{ fill: 'var(--card)', stroke: color }} />
                  )}
                  {n.kind === 'criterion' && (
                    <polygon points={`0,${-r} ${r},0 0,${r} ${-r},0`} strokeWidth={1.5} style={{ fill: 'var(--card)', stroke: color }} />
                  )}
                  {showLabel && (
                    <text
                      y={r + 13 / fit.s}
                      textAnchor="middle"
                      fontSize={(n.kind === 'note' ? 12.5 : 11) / fit.s}
                      style={{
                        fill: n.kind === 'note' ? 'var(--foreground)' : 'var(--muted-foreground)',
                        fontFamily: n.kind === 'note' ? 'var(--font-sans)' : 'var(--font-mono)',
                        fontWeight: sel ? 600 : 400,
                        paintOrder: 'stroke',
                        stroke: 'var(--background)',
                        strokeWidth: 3 / fit.s,
                      }}
                    >
                      {n.title.length > 34 ? n.title.slice(0, 33) + '…' : n.title}
                    </text>
                  )}
                </g>
              )
            })}
          </g>
          </g>
        </svg>
        <div className="pointer-events-none absolute bottom-3 left-3 flex max-w-[70%] flex-wrap gap-x-4 gap-y-1.5 border bg-popover/90 px-3 py-2 font-mono text-[0.6875rem] text-muted-foreground">
          {tops.map((f) => (
            <span key={f || '/'} className="flex items-center gap-1.5">
              <span className="inline-block size-2.5 rounded-full" style={{ background: colorOf(f) }} />
              {f || t('wiki.root')}
            </span>
          ))}
          <span className="flex items-center gap-1.5">
            <span className="inline-block size-2.5 rotate-45 border border-teal" />
            {t('wiki.graphCriterion')}
          </span>
          <span className="flex items-center gap-1.5">
            <span className={cn('inline-block h-0.5 w-4 bg-accent-2')} />
            {t('wiki.graphLink')}
          </span>
        </div>
      </div>
    </div>
  )
}
