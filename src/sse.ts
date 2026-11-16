export interface SSEMessage {
  event?: string
  data: string
}

// A lone "\r" at the very end may be the first half of a "\r\n" split across
// chunks, so it only counts as a line end once more data has arrived.
const LINE_END = /\r\n|\n|\r(?!$)/

/** Parses a server-sent events body into messages. */
export async function* readSSE(body: AsyncIterable<Uint8Array>): AsyncGenerator<SSEMessage> {
  const decoder = new TextDecoder()
  let buffer = ""
  let event: string | undefined
  let data: string[] = []

  const take = (line: string): SSEMessage | undefined => {
    if (line === "") {
      const message = data.length ? { event, data: data.join("\n") } : undefined
      event = undefined
      data = []
      return message
    }
    if (line.startsWith(":")) return undefined
    const colon = line.indexOf(":")
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? "" : line.slice(colon + 1)
    if (value.startsWith(" ")) value = value.slice(1)
    if (field === "data") data.push(value)
    else if (field === "event") event = value
    return undefined
  }

  function* drain(): Generator<SSEMessage> {
    for (let match = LINE_END.exec(buffer); match; match = LINE_END.exec(buffer)) {
      const line = buffer.slice(0, match.index)
      buffer = buffer.slice(match.index + match[0].length)
      const message = take(line)
      if (message) yield message
    }
  }

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true })
    yield* drain()
  }

  buffer += decoder.decode()
  if (buffer.endsWith("\r")) buffer = `${buffer.slice(0, -1)}\n`
  yield* drain()
  if (buffer) {
    take(buffer)
    buffer = ""
  }
  const last = take("")
  if (last) yield last
}
