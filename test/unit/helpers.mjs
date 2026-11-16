import { createServer } from "node:http"

import { buildProviders, parseCatalog } from "../../dist/catalog.js"

/** A slice of the real models.dev entries for OpenCode Zen and Go. */
export const CATALOG = {
  opencode: {
    id: "opencode",
    name: "OpenCode Zen",
    npm: "@ai-sdk/openai-compatible",
    api: "https://opencode.ai/inference/openai/v1",
    env: ["OPENCODE_API_KEY"],
    models: {
      "claude-sonnet-4-6": {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        family: "claude-sonnet",
        tool_call: true,
        reasoning: true,
        limit: { context: 1000000, output: 64000 },
        provider: { npm: "@ai-sdk/anthropic", api: "https://opencode.ai/inference/anthropic/v1" },
        release_date: "2026-02-17",
      },
      "gpt-5.5": {
        id: "gpt-5.5",
        name: "GPT-5.5",
        tool_call: true,
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh"] }],
        temperature: false,
        limit: { context: 1050000, output: 128000 },
        modalities: { input: ["text", "image", "pdf"], output: ["text"] },
        provider: { npm: "@ai-sdk/openai", api: "https://opencode.ai/inference/openai/v1" },
        release_date: "2026-04-23",
      },
      "gemini-3.1-pro": {
        id: "gemini-3.1-pro",
        tool_call: true,
        provider: { npm: "@ai-sdk/google", api: "https://opencode.ai/inference/google/v1beta" },
      },
    },
  },
  "opencode-go": {
    id: "opencode-go",
    name: "OpenCode Go",
    npm: "@ai-sdk/openai-compatible",
    api: "https://opencode.ai/inference/go/openai/v1",
    env: ["OPENCODE_API_KEY"],
    models: {
      "glm-5.3": {
        id: "glm-5.3",
        name: "GLM-5.3",
        tool_call: true,
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
        interleaved: { field: "reasoning_content" },
        temperature: true,
        limit: { context: 1000000, output: 131072 },
        modalities: { input: ["text"], output: ["text"] },
        release_date: "2026-08-14",
      },
      "minimax-m3": {
        id: "minimax-m3",
        name: "MiniMax-M3",
        tool_call: true,
        reasoning: true,
        limit: { context: 1000000, output: 131072 },
        provider: { npm: "@ai-sdk/anthropic", api: "https://opencode.ai/inference/go/anthropic/v1" },
        release_date: "2026-06-01",
      },
      "old-model": { id: "old-model", tool_call: true, status: "deprecated" },
    },
  },
}

export function providers(overrides = {}) {
  return buildProviders(parseCatalog(JSON.stringify(CATALOG)), overrides)
}

/** Feeds a list of SSE `data:` payloads (objects or strings) as a byte stream. */
export async function* sseBytes(payloads, { event = false } = {}) {
  const encoder = new TextEncoder()
  for (const payload of payloads) {
    const data = typeof payload === "string" ? payload : JSON.stringify(payload)
    const prefix = event && typeof payload === "object" && payload.type ? `event: ${payload.type}\n` : ""
    yield encoder.encode(`${prefix}data: ${data}\n\n`)
  }
}

/** Collects what a MessageBuilder emits. */
export function recorder() {
  const events = []
  return { events, emit: (event, data) => events.push({ event, data }) }
}

export const silent = () => {}

/** An HTTP server that records requests and answers with a handler per path. */
export async function fakeUpstream(handlers) {
  const requests = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const text = Buffer.concat(chunks).toString("utf8")
    const request = { method: req.method, url: req.url, headers: req.headers, body: text ? JSON.parse(text) : undefined }
    requests.push(request)
    const handler = handlers[new URL(req.url, "http://x").pathname]
    if (!handler) {
      res.writeHead(404, { "content-type": "application/json" })
      return res.end(JSON.stringify({ error: { message: `no handler for ${req.url}` } }))
    }
    await handler(request, res)
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address()
  return {
    requests,
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}

export function writeSSE(res, payloads, { named = false } = {}) {
  res.writeHead(200, { "content-type": "text/event-stream" })
  for (const payload of payloads) {
    const data = typeof payload === "string" ? payload : JSON.stringify(payload)
    if (named && typeof payload === "object") res.write(`event: ${payload.type}\n`)
    res.write(`data: ${data}\n\n`)
  }
  res.end()
}

/** Parses an Anthropic SSE response body into [{ event, data }]. */
export function parseAnthropicSSE(text) {
  return text
    .split("\n\n")
    .filter((block) => block.trim())
    .map((block) => {
      const event = /^event: (.*)$/m.exec(block)?.[1]
      const data = /^data: (.*)$/m.exec(block)?.[1]
      return { event, data: data ? JSON.parse(data) : undefined }
    })
}
