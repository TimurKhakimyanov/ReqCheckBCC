// Разбор потока Server-Sent Events (text/event-stream) для fetch + ReadableStream.
// EventSource умеет только GET, а чат — это POST, поэтому парсер свой. Формат: https://html.spec.whatwg.org/multipage/server-sent-events.html

export interface SSEMessage {
  event: string
  data: string
  id?: string
}

/** Инкрементальный парсер: кормите кусками текста, получаете события по мере появления пустой строки. */
export function createSSEParser(onMessage: (msg: SSEMessage) => void) {
  let buffer = ''
  let event = ''
  let data: string[] = []
  let id: string | undefined

  const dispatch = () => {
    if (data.length > 0) onMessage({ event: event || 'message', data: data.join('\n'), id })
    event = ''
    data = []
  }

  const processLine = (line: string) => {
    if (line === '') return dispatch()
    if (line.startsWith(':')) return // комментарий / keep-alive
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    else if (field === 'data') data.push(value)
    else if (field === 'id') id = value
  }

  return {
    feed(chunk: string) {
      buffer += chunk
      // Строки заканчиваются на \n, \r\n или \r. Неполная строка остаётся в буфере.
      let start = 0
      for (let i = 0; i < buffer.length; i++) {
        const ch = buffer[i]
        if (ch !== '\n' && ch !== '\r') continue
        // Одиночный \r в конце куска может оказаться началом \r\n — ждём следующий кусок.
        if (ch === '\r' && i === buffer.length - 1) break
        processLine(buffer.slice(start, i))
        if (ch === '\r' && buffer[i + 1] === '\n') i++
        start = i + 1
      }
      buffer = buffer.slice(start)
    },
    /** Конец потока: незавершённое событие без пустой строки по спецификации отбрасывается. */
    end() {
      if (buffer.endsWith('\r')) {
        processLine(buffer.slice(0, -1))
        dispatch()
      }
      buffer = ''
    },
  }
}

/** Асинхронный итератор событий из тела ответа fetch. */
export async function* readSSE(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SSEMessage> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const queue: SSEMessage[] = []
  const parser = createSSEParser((m) => queue.push(m))
  try {
    while (true) {
      if (signal?.aborted) return
      const { value, done } = await reader.read()
      if (done) {
        parser.feed(decoder.decode())
        parser.end()
        while (queue.length) yield queue.shift()!
        return
      }
      parser.feed(decoder.decode(value, { stream: true }))
      while (queue.length) yield queue.shift()!
    }
  } finally {
    reader.releaseLock()
  }
}

/** Сериализация события — для моков и тестов. */
export function formatSSE(event: string, data: unknown): string {
  const text = typeof data === 'string' ? data : JSON.stringify(data)
  return `event: ${event}\n${text
    .split('\n')
    .map((l) => `data: ${l}`)
    .join('\n')}\n\n`
}
