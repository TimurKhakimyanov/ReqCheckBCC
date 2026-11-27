import { useTranslation } from 'react-i18next'
import { AGENTS, type AgentState } from './agents'

/*
 * Изометрическая сцена прогона. Два вида:
 *  - конвейер: документ идёт по светящимся дорожкам через 7 станций-агентов к отчёту;
 *  - стопка слоёв: каждый агент — плита, текущая подсвечена и раздвигает стопку.
 * Вся анимация — CSS-переходы и SVG animateMotion; стили — в index.css (.rc-scene, .rc-st, .rc-layer).
 */

type Pt = [number, number]
const DOC: Pt = [98, 84]
const STATIONS: Pt[] = [
  [210, 140],
  [322, 196],
  [434, 252],
  [546, 308],
  [378, 392],
  [266, 336],
  [154, 280],
]
const REPORT: Pt = [42, 224]
const PATH: Pt[] = [DOC, ...STATIONS, REPORT]
const SCENE_TOP = -60

const seg = (a: Pt, b: Pt) => `M${a[0]} ${a[1]} L${b[0]} ${b[1]}`

function Cube({ label }: { label: string }) {
  return (
    <g className="cube">
      <polygon className="cl" points="-22,0 0,11 0,-19 -22,-30" />
      <polygon className="cr" points="0,11 22,0 22,-30 0,-19" />
      <polygon className="ct" points="0,-41 22,-30 0,-19 -22,-30" />
      <text className="cx" transform="matrix(0.62 0.31 -0.62 0.31 0 -30)" textAnchor="middle" dominantBaseline="middle">
        {label}
      </text>
    </g>
  )
}

function Station({ at, state, num, label, fx = true }: { at: Pt; state: AgentState; num: string; label: string; fx?: boolean }) {
  return (
    <g className="rc-st" data-state={state} transform={`translate(${at[0]} ${at[1]})`}>
      {fx && <ellipse className="glow" rx="58" ry="29" fill="url(#rcOrangeR)" filter="url(#rcBlur)" />}
      <polygon className="pad" points="0,-20 40,0 0,20 -40,0" />
      <g className="ok">
        <ellipse className="ring-ok" rx="48" ry="24" />
      </g>
      {fx && (
        <g className="fx">
          <ellipse className="ring" rx="46" ry="23" />
          <ellipse className="ring r2" rx="46" ry="23" />
          <line className="beam" x1="0" y1="-48" x2="0" y2={SCENE_TOP - at[1]} />
        </g>
      )}
      <Cube label={num} />
      <text className="lbl" x="0" y="36" textAnchor="middle">
        {label}
      </text>
    </g>
  )
}

export function ConveyorScene({ states, finished }: { states: AgentState[]; finished: boolean }) {
  const { t } = useTranslation()
  const activeIdx = states.findIndex((s) => s === 'active' || s === 'failed')
  // состояние участка дорожки k (ведёт к станции k; последний — к отчёту)
  const segState = (k: number): AgentState => {
    if (finished) return 'done'
    if (k < STATIONS.length) {
      const s = states[k]
      return s === 'done' ? 'done' : s === 'active' ? 'active' : s === 'failed' ? 'failed' : 'pending'
    }
    return 'pending'
  }
  const flowOn = (k: number) => finished || (activeIdx >= 0 && k <= activeIdx && states[activeIdx] !== 'failed')
  const stationOrder = STATIONS.map((p, i) => ({ p, i })).sort((a, b) => a.p[1] - b.p[1])
  const reportState: AgentState = finished ? 'done' : 'pending'

  return (
    <svg
      className="rc-scene absolute inset-0 block size-full"
      viewBox="0 -60 660 560"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={t('runView.sceneLabel')}
    >
      <defs>
        <filter id="rcGlow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="2.6" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <filter id="rcBlur" x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="10" />
        </filter>
        <radialGradient id="rcOrangeR">
          <stop offset="0" stopColor="#EF7722" stopOpacity=".9" />
          <stop offset="1" stopColor="#EF7722" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="rcBeam" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor="#EF7722" stopOpacity=".9" />
          <stop offset="1" stopColor="#EF7722" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="rcGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#F0642F" />
          <stop offset="1" stopColor="#B84DDA" />
        </linearGradient>
        <pattern id="rcHatchO" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="4" height="4" fill="#1F1A22" />
          <line x1="0" y1="0" x2="0" y2="4" stroke="rgba(194,90,208,.6)" strokeWidth="1" />
        </pattern>
        <pattern id="rcHatchT" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="4" height="4" fill="#142322" />
          <line x1="0" y1="0" x2="0" y2="4" stroke="rgba(34,181,165,.6)" strokeWidth="1" />
        </pattern>
      </defs>

      {[
        'M60 420 h12 M66 414 v12',
        'M520 120 h12 M526 114 v12',
        'M600 460 h12 M606 454 v12',
        'M300 470 h12 M306 464 v12',
        'M40 120 h12 M46 114 v12',
        'M460 400 l8 4 l-8 4',
        'M150 470 l8 4 l-8 4',
      ].map((d) => (
        <path key={d} className="mark" d={d} />
      ))}

      <path className="trk trk-base" d={`M${PATH.map((p) => p.join(' ')).join(' L')}`} />
      {PATH.slice(1).map((p, k) => (
        <path key={k} className="trk trk-glow" data-state={segState(k)} d={seg(PATH[k], p)} />
      ))}

      {PATH.slice(1).map((p, k) => {
        const d = seg(PATH[k], p)
        const dur = k === 4 ? 3.4 : 2.6
        return (
          <g key={k} className="flow" data-on={flowOn(k)} data-hot={!finished && k === activeIdx}>
            {[0, dur / 2].map((off) => (
              <g key={off}>
                <polygon className="pk" points="0,-4 8,0 0,4 -8,0" />
                <animateMotion dur={`${dur}s`} begin={`-${off}s`} repeatCount="indefinite" path={d} />
              </g>
            ))}
          </g>
        )
      })}

      <g transform={`translate(${DOC[0]} ${DOC[1]})`}>
        <polygon points="0,-14 28,0 0,14 -28,0" stroke="#6A86F0" style={{ fill: 'var(--scene-pad)' }} />
        <polygon points="0,-18 24,-6 0,6 -24,-6" stroke="#8FB0FF" style={{ fill: 'var(--scene-face-t)' }} />
        <polygon points="0,-28 24,-16 0,-4 -24,-16" fill="#6A86F0" stroke="#A9BEFF" />
        <text
          transform="matrix(0.62 0.31 -0.62 0.31 0 -16)"
          textAnchor="middle"
          dominantBaseline="middle"
          fontSize="9"
          fontWeight="600"
          fill="#16161A"
          style={{ fontFamily: 'var(--font-mono)' }}
        >
          DOC
        </text>
        <text x="0" y="30" textAnchor="middle" fontSize="9" letterSpacing=".08em" style={{ fontFamily: 'var(--font-mono)', fill: 'var(--accent-2)' }}>
          {t('runView.docNode')}
        </text>
      </g>

      {stationOrder.map(({ p, i }) => (
        <Station key={i} at={p} state={states[i]} num={String(i + 1).padStart(2, '0')} label={AGENTS[i].short} />
      ))}
      <Station at={REPORT} state={reportState} num="✓" label={t('runView.reportNode')} fx={false} />
    </svg>
  )
}

const TILES: Pt[] = [
  [120, 13.8],
  [156.6, 32.1],
  [83.4, 32.1],
  [193.4, 50.5],
  [120, 50.4],
  [46.6, 50.5],
  [156.7, 68.8],
  [83.3, 68.8],
  [120, 87.2],
]

export function StackScene({ states, finished }: { states: AgentState[]; finished: boolean }) {
  const { t } = useTranslation()
  const activeIdx = states.findIndex((s) => s === 'active' || s === 'failed')
  return (
    <div className="absolute top-24 left-1/2 h-[560px] w-[640px] -translate-x-1/2" role="img" aria-label={t('runView.stackLabel')}>
      {AGENTS.map((a, i) => {
        const off = finished || activeIdx < 0 ? 0 : i < activeIdx ? -18 : i > activeIdx ? 18 : 0
        return (
          <div key={a.stage} className="rc-layer" data-state={states[i]} style={{ top: 44 * i + off, zIndex: 20 - i }}>
            <svg viewBox="0 0 240 150" aria-hidden>
              <polygon className="side" points="10,65 120,120 120,130 10,75" />
              <polygon className="side" points="120,120 230,65 230,75 120,130" />
              <polygon className="top" points="120,10 230,65 120,120 10,65" />
              <g className="grid">
                <line x1="156.7" y1="28.3" x2="46.7" y2="83.3" />
                <line x1="193.3" y1="46.7" x2="83.3" y2="101.7" />
                <line x1="83.3" y1="28.3" x2="193.3" y2="83.3" />
                <line x1="46.7" y1="46.7" x2="156.7" y2="101.7" />
              </g>
              <text className="code" transform="translate(22 80) rotate(26.57)">
                {a.code} · {a.short}
              </text>
              <g className="tiles">
                {TILES.map(([x, y], k) => (
                  <g key={k} transform={`translate(${x} ${y})`}>
                    <g className="tile" style={{ animationDelay: `${((Math.round(y) - 14) / 18.4) * 0.2}s` }}>
                      <polygon className="tl" points="-29,7.5 0,22 0,29 -29,14.5" />
                      <polygon className="tr" points="0,22 29,7.5 29,14.5 0,29" />
                      <polygon className="tt" points="0,-7 29,7.5 0,22 -29,7.5" />
                    </g>
                  </g>
                ))}
              </g>
            </svg>
          </div>
        )
      })}
    </div>
  )
}

/** Куб агента для панели деталей: цвет и вращающееся кольцо — по состоянию. */
export function AgentCube({ state, short }: { state: AgentState; short: string }) {
  const color =
    state === 'done' ? 'var(--teal)' : state === 'active' ? 'var(--primary)' : state === 'failed' ? 'var(--destructive)' : 'var(--scene-edge)'
  const top = state === 'pending' ? 'var(--scene-face-t)' : color
  return (
    <svg viewBox="-110 -70 220 120" className="h-[120px] w-[220px] overflow-visible" aria-hidden>
      <ellipse className="rc-spin-dash rc-smooth" rx="92" ry="34" cy="8" fill="none" strokeWidth="1.2" style={{ stroke: color }} />
      <ellipse rx="70" ry="26" cy="8" fill="none" style={{ stroke: 'var(--border)' }} />
      <g className={state === 'active' ? 'rc-breath' : undefined}>
        <polygon points="-40,0 0,20 0,-18 -40,-38" strokeWidth="1.2" style={{ fill: 'var(--scene-face-l)', stroke: color }} />
        <polygon points="0,20 40,0 40,-38 0,-18" strokeWidth="1.2" style={{ fill: 'var(--scene-face-r)', stroke: color }} />
        <polygon points="0,-58 40,-38 0,-18 -40,-38" strokeWidth="1.2" style={{ fill: top, stroke: color, transition: 'fill .9s ease' }} />
        <text
          transform="matrix(0.72 0.36 -0.72 0.36 0 -38)"
          textAnchor="middle"
          dominantBaseline="middle"
          fontSize="14"
          fontWeight="600"
          style={{ fontFamily: 'var(--font-mono)', fill: state === 'pending' ? 'var(--scene-label)' : '#16161A' }}
        >
          {short}
        </text>
      </g>
    </svg>
  )
}
