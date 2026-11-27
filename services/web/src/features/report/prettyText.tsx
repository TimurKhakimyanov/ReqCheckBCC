import type { ReactNode } from 'react'
import type { Range, Segment } from './highlight'

/*
 * Читаемый вид нормализованного текста документа. Текст после разбора PDF/DOCX/MD — это Markdown:
 * заголовки «#», таблицы «| … |», списки «* », «**жирный**», линии «---». Каждая строка становится
 * блоком (заголовок, абзац, пункт списка, строка таблицы), а подсветка цитат накладывается на
 * «листья» — куски текста с точными смещениями в исходном тексте. Цитата, которая пересекает
 * границы ячеек или строк, распадается на несколько <mark>; data-loc — только у первого куска.
 * Символы разметки (#, **, «* ») остаются в DOM скрытыми span'ами (.md-syn).
 */

const HEADING = /^(#{1,6})[ \t]+/
const TABLE_ROW = /^[ \t]*\|/
const TABLE_SEP = /^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/
const HR = /^[ \t]*(-{3,}|\*{3,}|_{3,})[ \t]*$/
const BULLET = /^([ \t]*)([*+-])[ \t]+/
const BOLD = /(\*\*|__)/g

export interface Heading {
  /** Смещение начала строки заголовка в тексте */
  start: number
  level: number
  title: string
}

/** Заголовки Markdown с их смещениями — для оглавления над текстом. */
export function findHeadings(text: string): Heading[] {
  const out: Heading[] = []
  let at = 0
  for (const line of text.split('\n')) {
    const h = HEADING.exec(line)
    if (h) out.push({ start: at, level: h[1].length, title: line.slice(h[0].length).replace(BOLD, '').trim() })
    at += line.length + 1
  }
  return out
}

/** Кусок подсвеченного текста, обрезанный по границам листа. */
export interface Piece {
  start: number
  end: number
  ranges: Range[]
}

export type RenderMark = (piece: Piece, key: string, children: ReactNode[]) => ReactNode

interface InlineState {
  bold: boolean
}

/** «**» и «__» прячутся, текст между ними — жирный (состояние тянется через куски одного блока). */
function inline(s: string, key: string, st: InlineState): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let i = 0
  const push = (txt: string) => {
    if (!txt) return
    out.push(st.bold ? <strong key={`${key}-b${i++}`}>{txt}</strong> : txt)
  }
  for (const m of s.matchAll(BOLD)) {
    const at = m.index ?? 0
    push(s.slice(last, at))
    out.push(
      <span key={`${key}-s${i++}`} className="md-syn">
        {m[0]}
      </span>,
    )
    st.bold = !st.bold
    last = at + m[0].length
  }
  push(s.slice(last))
  return out
}

/** Индекс первого сегмента, который заканчивается после pos (сегменты идут подряд и покрывают текст). */
function firstSegment(segments: Segment[], pos: number): number {
  let lo = 0
  let hi = segments.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (segments[mid].end <= pos) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * Блоки документа. `segments` — результат buildSegments по всему тексту (подряд, без дыр);
 * `renderMark` рисует подсвеченный кусок.
 */
export function renderDocument(text: string, segments: Segment[], renderMark: RenderMark): ReactNode[] {
  const leaf = (s: number, e: number, key: string, st: InlineState): ReactNode[] => {
    if (e <= s) return []
    const out: ReactNode[] = []
    for (let i = firstSegment(segments, s); i < segments.length && segments[i].start < e; i++) {
      const seg = segments[i]
      const cs = Math.max(seg.start, s)
      const ce = Math.min(seg.end, e)
      if (ce <= cs) continue
      const k = `${key}:${cs}`
      const nodes = inline(text.slice(cs, ce), k, st)
      if (!seg.ranges.length) out.push(...nodes)
      else out.push(renderMark({ start: cs, end: ce, ranges: seg.ranges }, k, nodes))
    }
    return out
  }

  const lines: { start: number; end: number; text: string }[] = []
  let at = 0
  for (const line of text.split('\n')) {
    lines.push({ start: at, end: at + line.length, text: line })
    at += line.length + 1
  }

  const blocks: ReactNode[] = []
  for (let li = 0; li < lines.length; li++) {
    const ln = lines[li]
    const key = String(ln.start)

    // таблица: подряд идущие строки «| … |»
    if (TABLE_ROW.test(ln.text)) {
      const rows: (typeof ln)[] = []
      let headerRows = 0
      while (li < lines.length && TABLE_ROW.test(lines[li].text)) {
        if (TABLE_SEP.test(lines[li].text)) {
          if (!headerRows) headerRows = rows.length
        } else rows.push(lines[li])
        li++
      }
      li--
      const cellsOf = (row: typeof ln) => {
        const pipes: number[] = []
        for (let i = 0; i < row.text.length; i++) if (row.text[i] === '|' && row.text[i - 1] !== '\\') pipes.push(i)
        if (row.text.trimEnd().length - 1 !== pipes[pipes.length - 1]) pipes.push(row.text.length)
        const cells: [number, number][] = []
        for (let i = 0; i < pipes.length - 1; i++) {
          let s = pipes[i] + 1
          let e = pipes[i + 1]
          while (s < e && /\s/.test(row.text[s])) s++
          while (e > s && /\s/.test(row.text[e - 1])) e--
          cells.push([row.start + s, row.start + e])
        }
        return cells
      }
      const renderRow = (row: typeof ln, head: boolean) => {
        const st = { bold: false }
        return (
          <tr key={row.start}>
            {cellsOf(row).map(([s, e]) =>
              head ? <th key={s}>{leaf(s, e, String(s), st)}</th> : <td key={s}>{leaf(s, e, String(s), st)}</td>,
            )}
          </tr>
        )
      }
      blocks.push(
        <div key={key} className="md-table-wrap">
          <table className="md-table">
            {headerRows > 0 && <thead>{rows.slice(0, headerRows).map((r) => renderRow(r, true))}</thead>}
            <tbody>{rows.slice(headerRows).map((r) => renderRow(r, false))}</tbody>
          </table>
        </div>,
      )
      continue
    }

    const st = { bold: false }
    if (!ln.text.trim()) {
      // несколько пустых строк подряд — один отступ
      if (li === 0 || lines[li - 1].text.trim()) blocks.push(<div key={key} className="md-gap" aria-hidden />)
      continue
    }
    if (HR.test(ln.text)) {
      blocks.push(<hr key={key} className="md-hr" />)
      continue
    }
    const h = HEADING.exec(ln.text)
    if (h) {
      const level = h[1].length
      blocks.push(
        <div key={key} className={`md-h md-h${level}`} data-h={ln.start} role="heading" aria-level={level}>
          <span className="md-syn">{h[0]}</span>
          {leaf(ln.start + h[0].length, ln.end, key, st)}
        </div>,
      )
      continue
    }
    const b = BULLET.exec(ln.text)
    if (b) {
      blocks.push(
        <div key={key} className="md-li" style={b[1] ? { paddingLeft: `${Math.min(b[1].length, 8) * 0.6}em` } : undefined}>
          <span className="md-bullet" aria-hidden>
            •
          </span>
          <span>
            <span className="md-syn">{b[0]}</span>
            {leaf(ln.start + b[0].length, ln.end, key, st)}
          </span>
        </div>,
      )
      continue
    }
    blocks.push(
      <p key={key} className="md-p">
        {leaf(ln.start, ln.end, key, st)}
      </p>,
    )
  }
  return blocks
}
