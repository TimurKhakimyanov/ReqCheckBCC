// Безопасный рендер Markdown заметок вики: заголовки, абзацы, списки, цитаты, код, таблицы, линии,
// **жирный**, _курсив_, `код`, [текст](https://…) и вики-ссылки [[Заметка|подпись]].
// HTML не интерпретируется — только React-узлы, поэтому XSS из текста заметки невозможен.
import { Fragment, type ReactNode } from 'react'
import { cn } from '@/shared/utils'

export interface WikiLinkTarget {
  /** id найденной заметки; null — заметки с таким названием нет */
  id: string | null
}

interface Props {
  text: string
  /** Находит заметку по названию из [[…]] */
  resolve?: (title: string) => WikiLinkTarget
  onOpen?: (id: string) => void
  /** Ссылка [[…]] на несуществующую заметку — предложить создать */
  onCreate?: (title: string) => void
  /** Подсказка у ссылки на несуществующую заметку */
  missingHint?: string
  className?: string
}

const INLINE = /(\[\[[^[\]\n]+\]\]|\[[^[\]\n]+\]\((?:https?:\/\/|#)[^)\s]+\)|\*\*[^*]+\*\*|`[^`]+`|_[^_\s][^_]*_|\*[^*\s][^*]*\*)/g

function Inline({ text, ctx, k }: { text: string; ctx: Props; k: string }) {
  const out: ReactNode[] = []
  let last = 0
  let i = 0
  for (const m of text.matchAll(INLINE)) {
    const tok = m[0]
    const at = m.index ?? 0
    if (at > last) out.push(text.slice(last, at))
    const key = `${k}-${i++}`
    if (tok.startsWith('[[')) {
      const [target, label] = tok.slice(2, -2).split('|')
      const title = target.trim()
      const found = ctx.resolve?.(title) ?? { id: null }
      out.push(
        found.id ? (
          <button
            key={key}
            type="button"
            onClick={() => ctx.onOpen?.(found.id!)}
            className="cursor-pointer text-accent-2 underline decoration-accent-2/40 underline-offset-2 hover:decoration-accent-2"
          >
            {(label ?? target).trim()}
          </button>
        ) : (
          <button
            key={key}
            type="button"
            onClick={() => ctx.onCreate?.(title)}
            title={ctx.missingHint}
            className="cursor-pointer text-destructive underline decoration-dashed underline-offset-2"
          >
            {(label ?? target).trim()}
          </button>
        ),
      )
    } else if (tok.startsWith('[')) {
      const mm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok)!
      out.push(
        <a key={key} href={mm[2]} target={mm[2].startsWith('#') ? undefined : '_blank'} rel="noopener noreferrer" className="text-accent-2 underline underline-offset-2">
          {mm[1]}
        </a>,
      )
    } else if (tok.startsWith('**')) out.push(<strong key={key} className="font-semibold">{tok.slice(2, -2)}</strong>)
    else if (tok.startsWith('`')) out.push(<code key={key} className="bg-muted px-1 font-mono text-[0.88em]">{tok.slice(1, -1)}</code>)
    else out.push(<em key={key}>{tok.slice(1, -1)}</em>)
    last = at + tok.length
  }
  if (last < text.length) out.push(text.slice(last))
  return <>{out}</>
}

const isRow = (l: string) => /^\s*\|.*\|\s*$/.test(l)
const isSep = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l)
const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())

/** Разбор на блоки. Возвращает и якоря заголовков — для оглавления. */
export function parseBlocks(text: string) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const blocks: { type: string; lines: string[]; level?: number; lang?: string }[] = []
  let i = 0
  while (i < lines.length) {
    const l = lines[i]
    if (!l.trim()) {
      i++
      continue
    }
    const fence = /^```(\w*)/.exec(l)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i].startsWith('```')) body.push(lines[i++])
      i++
      blocks.push({ type: 'code', lines: body, lang: fence[1] })
      continue
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(l)
    if (h) {
      blocks.push({ type: 'h', lines: [h[2]], level: h[1].length })
      i++
      continue
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(l)) {
      blocks.push({ type: 'hr', lines: [] })
      i++
      continue
    }
    if (isRow(l) && i + 1 < lines.length && isSep(lines[i + 1])) {
      const rows = [l]
      i += 2
      while (i < lines.length && isRow(lines[i])) rows.push(lines[i++])
      blocks.push({ type: 'table', lines: rows })
      continue
    }
    const kinds: [string, RegExp][] = [
      ['quote', /^\s*>\s?/],
      ['ul', /^\s*[-*•]\s+/],
      ['ol', /^\s*\d+[.)]\s+/],
    ]
    const kind = kinds.find(([, re]) => re.test(l))
    if (kind) {
      const body: string[] = []
      while (i < lines.length && kind[1].test(lines[i])) body.push(lines[i++].replace(kind[1], ''))
      blocks.push({ type: kind[0], lines: body })
      continue
    }
    const para: string[] = []
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\s*>|\s*[-*•]\s|\s*\d+[.)]\s)/.test(lines[i]) && !isRow(lines[i]))
      para.push(lines[i++])
    if (!para.length) para.push(lines[i++])
    blocks.push({ type: 'p', lines: para })
  }
  return blocks
}

export const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '')

export function WikiMarkdown(props: Props) {
  const blocks = parseBlocks(props.text)
  return (
    <div className={cn('grid gap-3 text-[0.9375rem] leading-relaxed', props.className)}>
      {blocks.map((b, bi) => {
        const k = String(bi)
        if (b.type === 'h') {
          const size = ['text-2xl font-semibold tracking-tight', 'mt-3 text-xl font-semibold', 'mt-2 text-base font-semibold', 'text-sm font-semibold uppercase tracking-wide'][b.level! - 1]
          const Tag = (['h1', 'h2', 'h3', 'h4'] as const)[b.level! - 1]
          return (
            <Tag key={k} id={slug(b.lines[0])} className={cn('scroll-mt-4', size)}>
              <Inline text={b.lines[0]} ctx={props} k={k} />
            </Tag>
          )
        }
        if (b.type === 'hr') return <hr key={k} className="border-border" />
        if (b.type === 'code')
          return (
            <pre key={k} className="overflow-x-auto border bg-muted/60 p-3 font-mono text-[0.8125rem] leading-relaxed">
              <code>{b.lines.join('\n')}</code>
            </pre>
          )
        if (b.type === 'quote')
          return (
            <blockquote key={k} className="border-l-2 border-accent-2 bg-muted/40 py-1.5 pl-3 text-muted-foreground">
              {b.lines.map((l, li) => (
                <Fragment key={li}>
                  {li > 0 && <br />}
                  <Inline text={l} ctx={props} k={`${k}.${li}`} />
                </Fragment>
              ))}
            </blockquote>
          )
        if (b.type === 'ul' || b.type === 'ol') {
          const Tag = b.type
          return (
            <Tag key={k} className={cn('grid gap-1 pl-5', b.type === 'ol' ? 'list-decimal' : 'list-disc')}>
              {b.lines.map((l, li) => (
                <li key={li}>
                  <Inline text={l} ctx={props} k={`${k}.${li}`} />
                </li>
              ))}
            </Tag>
          )
        }
        if (b.type === 'table') {
          const [head, ...rows] = b.lines.map(cells)
          return (
            <div key={k} className="overflow-x-auto border">
              <table className="w-full border-collapse text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    {head.map((c, ci) => (
                      <th key={ci} className="border-b px-3 py-2 text-left font-medium">
                        <Inline text={c} ctx={props} k={`${k}.h${ci}`} />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, ri) => (
                    <tr key={ri} className="border-b last:border-b-0">
                      {r.map((c, ci) => (
                        <td key={ci} className="px-3 py-2 align-top">
                          <Inline text={c} ctx={props} k={`${k}.${ri}.${ci}`} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
        return (
          <p key={k}>
            {b.lines.map((l, li) => (
              <Fragment key={li}>
                {li > 0 && <br />}
                <Inline text={l} ctx={props} k={`${k}.${li}`} />
              </Fragment>
            ))}
          </p>
        )
      })}
    </div>
  )
}
