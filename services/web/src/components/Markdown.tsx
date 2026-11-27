// Минимальный безопасный рендер Markdown для ответов чата: абзацы, списки, **жирный**, _курсив_, `код`.
// HTML не интерпретируется (только React-узлы), поэтому XSS из ответа модели невозможен.
import { Fragment, type ReactNode } from 'react'

type Linker = (token: string, key: string) => ReactNode | null

function inline(text: string, linker?: Linker, keyPrefix = ''): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(\*\*[^*]+\*\*|`[^`]+`|_[^_\s][^_]*_|\b[DR]-\d{3}(?:\.\d+)?\b)/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const tok = m[0]
    const key = `${keyPrefix}-${i++}`
    if (tok.startsWith('**')) out.push(<strong key={key}>{inline(tok.slice(2, -2), linker, key)}</strong>)
    else if (tok.startsWith('`')) out.push(<code key={key} className="rounded bg-muted px-1 font-mono text-[0.85em]">{tok.slice(1, -1)}</code>)
    else if (tok.startsWith('_')) out.push(<em key={key}>{tok.slice(1, -1)}</em>)
    else out.push(linker?.(tok, key) ?? tok)
    last = m.index + tok.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export function Markdown({ text, linker }: { text: string; linker?: Linker }) {
  const blocks = text.replace(/\r\n/g, '\n').split(/\n{2,}/)
  return (
    <div className="grid gap-2">
      {blocks.map((block, bi) => {
        const lines = block.split('\n')
        const isUl = lines.every((l) => /^\s*[-*•]\s+/.test(l))
        const isOl = lines.every((l) => /^\s*\d+[.)]\s+/.test(l))
        if (isUl || isOl) {
          const Tag = isOl ? 'ol' : 'ul'
          return (
            <Tag key={bi} className={isOl ? 'list-decimal pl-5' : 'list-disc pl-5'}>
              {lines.map((l, li) => (
                <li key={li}>{inline(l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, ''), linker, `${bi}.${li}`)}</li>
              ))}
            </Tag>
          )
        }
        if (/^#{1,4}\s/.test(block)) return <p key={bi} className="font-semibold">{inline(block.replace(/^#+\s/, ''), linker, `${bi}`)}</p>
        return (
          <p key={bi}>
            {lines.map((l, li) => (
              <Fragment key={li}>
                {li > 0 && <br />}
                {inline(l, linker, `${bi}.${li}`)}
              </Fragment>
            ))}
          </p>
        )
      })}
    </div>
  )
}
