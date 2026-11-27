import { describe, expect, it } from 'vitest'
import { createSSEParser, formatSSE, readSSE, type SSEMessage } from './sse'

function parseAll(chunks: string[]): SSEMessage[] {
  const out: SSEMessage[] = []
  const p = createSSEParser((m) => out.push(m))
  chunks.forEach((c) => p.feed(c))
  p.end()
  return out
}

describe('SSE parser', () => {
  it('parses named events with JSON data', () => {
    const msgs = parseAll(['event: progress\ndata: {"stage":"parsing","progress":0.1}\n\n'])
    expect(msgs).toEqual([{ event: 'progress', data: '{"stage":"parsing","progress":0.1}', id: undefined }])
    expect(JSON.parse(msgs[0].data).stage).toBe('parsing')
  })

  it('defaults event name to "message" and joins multi-line data', () => {
    expect(parseAll(['data: line 1\ndata: line 2\n\n'])).toEqual([{ event: 'message', data: 'line 1\nline 2', id: undefined }])
  })

  it('handles events split across arbitrary chunk boundaries', () => {
    const text = formatSSE('token', { text: 'При' }) + formatSSE('token', { text: 'вет' }) + formatSSE('done', { id: 'm1' })
    const chunks = text.match(/[\s\S]{1,3}/g)!
    const msgs = parseAll(chunks)
    expect(msgs.map((m) => m.event)).toEqual(['token', 'token', 'done'])
    expect(msgs.map((m) => JSON.parse(m.data).text ?? '').join('')).toBe('Привет')
  })

  it('supports CRLF and CR line endings, including CR at a chunk boundary', () => {
    expect(parseAll(['event: a\r\ndata: 1\r\n\r\n'])).toHaveLength(1)
    expect(parseAll(['event: b\rdata: 2\r\r'])).toEqual([{ event: 'b', data: '2', id: undefined }])
    expect(parseAll(['event: c\r', '\ndata: 3\r', '\n\r', '\n'])).toEqual([{ event: 'c', data: '3', id: undefined }])
  })

  it('ignores comments, keep-alives and unknown fields, keeps id', () => {
    expect(parseAll([': ping\n\nretry: 1000\nid: 7\nfoo: bar\nevent: progress\ndata: x\n\n'])).toEqual([
      { event: 'progress', data: 'x', id: '7' },
    ])
  })

  it('drops an unterminated trailing event and events without data', () => {
    expect(parseAll(['event: empty\n\nevent: progress\ndata: unterminated'])).toEqual([])
  })

  it('reads a fetch ReadableStream body with multibyte UTF-8 split across chunks', async () => {
    const bytes = new TextEncoder().encode(formatSSE('token', { text: 'Ж' }) + formatSSE('done', {}))
    // режем посреди двухбайтового символа
    const cut = bytes.indexOf(0xd0) + 1
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, cut))
        c.enqueue(bytes.slice(cut))
        c.close()
      },
    })
    const got: SSEMessage[] = []
    for await (const m of readSSE(body)) got.push(m)
    expect(got.map((m) => m.event)).toEqual(['token', 'done'])
    expect(JSON.parse(got[0].data).text).toBe('Ж')
  })
})
