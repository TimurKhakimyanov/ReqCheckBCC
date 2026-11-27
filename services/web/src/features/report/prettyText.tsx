import type { ReactNode } from 'react'

/*
 * Читаемый вид нормализованного текста документа. Текст после разбора PDF/DOCX/MD — это Markdown
 * (заголовки «#», таблицы «| … |», «**»). Символы разметки не удаляются, а оборачиваются в span'ы,
 * которые CSS прячет или делает бледными (index.css: .md-syn, .md-sep, .md-pipe, .md-h*).
 * Поэтому textContent и смещения цитат не меняются: подсветка дефектов работает как раньше.
 */

const INLINE = /(\*\*|__|\|)/g
const HEADING = /^(#{1,6})([ \t]+)/
const TABLE_SEP = /^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/

function inline(s: string, key: string): ReactNode[] {
  if (!s) return []
  const out: ReactNode[] = []
  let last = 0
  let i = 0
  // крайние «|» строки таблицы прячем, внутренние показываем бледным разделителем
  const first = s.search(/\S/)
  const lastCh = s.trimEnd().length - 1
  for (const m of s.matchAll(INLINE)) {
    const at = m.index ?? 0
    if (at > last) out.push(s.slice(last, at))
    const edgePipe = m[0] === '|' && (at === first || at === lastCh)
    out.push(
      <span key={`${key}-${i++}`} className={m[0] === '|' && !edgePipe ? 'md-pipe' : 'md-syn'}>
        {m[0]}
      </span>,
    )
    last = at + m[0].length
  }
  if (last < s.length) out.push(s.slice(last))
  return out
}

/**
 * Разметка куска текста [start, start + chunk.length) полного документа `full`.
 * Заголовок и строка-разделитель таблицы распознаются, только если кусок начинается с начала строки.
 */
export function prettyText(full: string, start: number, chunk: string): ReactNode[] {
  const out: ReactNode[] = []
  let i = 0
  while (i < chunk.length) {
    const nl = chunk.indexOf('\n', i)
    const end = nl === -1 ? chunk.length : nl
    const line = chunk.slice(i, end)
    const atLineStart = start + i === 0 || full[start + i - 1] === '\n'
    const key = `${start + i}`
    if (atLineStart && TABLE_SEP.test(line) && line.includes('-')) {
      out.push(
        <span key={key} className="md-sep">
          {line}
        </span>,
      )
    } else {
      const h = atLineStart ? HEADING.exec(line) : null
      if (h) {
        out.push(
          <span key={`${key}-p`} className="md-syn">
            {h[0]}
          </span>,
          <span key={`${key}-h`} className={`md-h md-h${h[1].length}`}>
            {inline(line.slice(h[0].length), key)}
          </span>,
        )
      } else {
        out.push(...inline(line, key))
      }
    }
    if (nl === -1) break
    out.push('\n')
    i = nl + 1
  }
  return out
}
