import type { IncomingHttpHeaders, ServerResponse } from "node:http"

import type { Route } from "./catalog.js"
import {
  HttpError,
  describeError,
  errorTypeFor,
  sendError,
  sendJSON,
  upstreamMessage,
  withContextHint,
} from "./http.js"
import type { LogFn } from "./logger.js"
import { MessageBuilder } from "./message-builder.js"
import { readSSE, type SSEMessage } from "./sse.js"
import { prepareAnthropicBody } from "./translate/anthropic.js"
import { buildChatRequest, translateChatStream } from "./translate/chat.js"
import { ToolNames, estimateTokens, isClaudeRoute } from "./translate/common.js"
import { buildResponsesRequest, translateResponsesStream } from "./translate/responses.js"
import type { MessagesRequest, Usage } from "./types.js"
import { VERSION } from "./version.js"

export interface ForwardContext {
  body: MessagesRequest
  route: Route
  apiKey: string
  incoming: IncomingHttpHeaders
  res: ServerResponse
  signal: AbortSignal
  log: LogFn
  effort?: string
}

export interface ForwardResult {
  status: number
  usage?: Usage
}

export function forward(ctx: ForwardContext): Promise<ForwardResult> {
  return ctx.route.protocol === "anthropic" ? forwardAnthropic(ctx) : forwardTranslated(ctx)
}

// ---------------------------------------------------------------------------
// Claude Code's own Claude models: a transparent relay to Anthropic
// ---------------------------------------------------------------------------

// Managed by the HTTP stack on each hop, or private to this proxy.
const HOP_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "content-length",
  // fetch decompresses, so ask for an uncompressed body instead of relaying
  // bytes whose encoding header no longer matches.
  "accept-encoding",
  "x-cwo-token",
])

export interface RelayContext {
  method: string
  /** Path and query as Claude Code sent them, minus the proxy's token prefix. */
  path: string
  incoming: IncomingHttpHeaders
  /** The request body exactly as received; replaced only when `rewritten` is set. */
  raw?: Buffer
  rewritten?: unknown
  res: ServerResponse
  signal: AbortSignal
  /** Where Claude models go: api.anthropic.com, or the gateway the user already had. */
  anthropicURL: string
}

/**
 * Forwards a request to Anthropic as Claude Code made it: same method, path,
 * headers (its own login included) and body bytes. The proxy neither reads
 * nor stores the credentials it carries.
 */
export async function relayToAnthropic(ctx: RelayContext): Promise<{ status: number; error?: string }> {
  const headers = new Headers()
  for (const [name, value] of Object.entries(ctx.incoming)) {
    if (HOP_HEADERS.has(name) || value === undefined) continue
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item)
  }

  const body =
    ctx.method === "GET" || ctx.method === "HEAD"
      ? undefined
      : ctx.rewritten !== undefined
        ? JSON.stringify(ctx.rewritten)
        : ctx.raw

  const target = `${ctx.anthropicURL.replace(/\/+$/, "")}${ctx.path}`
  let upstream: Response
  try {
    upstream = await fetch(target, { method: ctx.method, headers, body, signal: ctx.signal, redirect: "manual" })
  } catch (error) {
    if (ctx.signal.aborted) throw error
    throw new HttpError(502, "api_error", `Could not reach ${new URL(target).host}: ${describeError(error)}`)
  }

  const out: Record<string, string> = {}
  upstream.headers.forEach((value, name) => {
    if (!HOP_HEADERS.has(name) && name !== "content-encoding") out[name] = value
  })
  ctx.res.writeHead(upstream.status, out)
  if (!upstream.ok) {
    // Error bodies are small and say why (rate limit, overload, ...): keep
    // the reason for the log, then pass the body on unchanged.
    const text = await upstream.text().catch(() => "")
    ctx.res.end(text)
    const reason = upstreamMessage(text)
    const type = errorType(text)
    return { status: upstream.status, error: [type, reason].filter(Boolean).join(": ").slice(0, 300) || "error" }
  }
  try {
    if (upstream.body) {
      for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) ctx.res.write(chunk)
    }
  } catch (error) {
    if (ctx.signal.aborted) return { status: 499 }
    throw error
  }
  ctx.res.end()
  return { status: upstream.status }
}

function errorType(text: string): string | undefined {
  try {
    const type = (JSON.parse(text) as { error?: { type?: unknown } }).error?.type
    return typeof type === "string" ? type : undefined
  } catch {
    return undefined
  }
}

const RELAYED_HEADERS = ["request-id", "retry-after", "x-should-retry"]

/**
 * Who is calling, for the provider. OpenCode Go asks every client for its
 * own user agent and a stable `x-opencode-session` per conversation, which
 * it uses for routing and prompt caching. Claude Code's session id is that
 * conversation key; a subagent is a conversation of its own.
 */
export function clientHeaders(incoming: IncomingHttpHeaders): Record<string, string> {
  const userAgent = header(incoming, "user-agent")
  const out: Record<string, string> = {
    "user-agent": `claude-with-opencode/${VERSION}${userAgent ? ` (${userAgent})` : ""}`,
  }
  for (const [name, value] of Object.entries(incoming)) {
    if (name.startsWith("x-claude-code-") && typeof value === "string") out[name] = value
  }
  const session = header(incoming, "x-claude-code-session-id")
  const agent = header(incoming, "x-claude-code-agent-id")
  if (session) out["x-opencode-session"] = agent ? `${session}:${agent}` : session
  return out
}

async function forwardAnthropic(ctx: ForwardContext): Promise<ForwardResult> {
  const { route, res, incoming } = ctx
  const headers: Record<string, string> = {
    ...clientHeaders(incoming),
    "x-api-key": ctx.apiKey,
    "anthropic-version": header(incoming, "anthropic-version") ?? "2023-06-01",
    ...route.headers,
  }
  // Claude Code's betas only mean something to Claude itself.
  const beta = header(incoming, "anthropic-beta")
  if (beta && isClaudeRoute(route)) headers["anthropic-beta"] = beta

  const upstream = await post(`${route.baseURL}/messages`, headers, prepareAnthropicBody(ctx.body, route), ctx.signal)
  const out: Record<string, string> = {
    "content-type": upstream.headers.get("content-type") ?? "application/json",
  }
  for (const name of RELAYED_HEADERS) {
    const value = upstream.headers.get(name)
    if (value) out[name] = value
  }
  res.writeHead(upstream.status, out)
  try {
    if (upstream.body) {
      for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk)
    }
  } catch (error) {
    // Claude Code cancelled (Esc): nothing left to answer.
    if (ctx.signal.aborted) return { status: 499 }
    throw error
  }
  res.end()
  return { status: upstream.status }
}

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache",
  connection: "keep-alive",
}

async function forwardTranslated(ctx: ForwardContext): Promise<ForwardResult> {
  const { body, route, res, signal, log } = ctx
  const names = new ToolNames()
  const chat = route.protocol === "openai-chat"
  const payload = chat
    ? buildChatRequest(body, route, names, ctx.effort)
    : buildResponsesRequest(body, route, names, ctx.effort)
  const url = `${route.baseURL}/${chat ? "chat/completions" : "responses"}`

  const upstream = await post(
    url,
    { ...clientHeaders(ctx.incoming), authorization: `Bearer ${ctx.apiKey}`, ...route.headers },
    payload,
    signal,
  )
  if (!upstream.ok) return relayError(upstream, res)

  // Upstream always streams; a non-streaming Claude Code request just gets
  // the assembled message at the end.
  const streaming = body.stream === true
  const emit = streaming
    ? (event: string, data: unknown) => {
        if (!res.writableEnded && !res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      }
    : undefined
  const builder = new MessageBuilder(body.model, emit, estimateTokens(body))
  if (streaming) {
    res.writeHead(200, SSE_HEADERS)
    res.flushHeaders()
  }
  // Long silent reasoning would otherwise look like a dead connection.
  const keepAlive = streaming ? setInterval(() => builder.ping(), 15_000) : undefined

  try {
    const events = eventsOf(upstream)
    if (chat) await translateChatStream(events, builder, names, log)
    else await translateResponsesStream(events, builder, names, route, log)
  } catch (error) {
    if (signal.aborted) return { status: 499 }
    const message = withContextHint(describeError(error))
    log("warn", `${route.ref}: upstream stream failed: ${message}`)
    if (streaming) {
      builder.error("api_error", message)
      res.end()
      return { status: 200 }
    }
    sendError(res, 502, "api_error", message)
    return { status: 502 }
  } finally {
    clearInterval(keepAlive)
  }

  if (streaming) res.end()
  else sendJSON(res, 200, builder.message())
  return { status: 200, usage: builder.usage }
}

async function* eventsOf(upstream: Response): AsyncGenerator<SSEMessage> {
  const type = upstream.headers.get("content-type") ?? ""
  if (type.includes("application/json")) {
    // Some servers ignore `stream: true`; translators accept a whole body as one "json" event.
    yield { event: "json", data: await upstream.text() }
    return
  }
  if (upstream.body) yield* readSSE(upstream.body as unknown as AsyncIterable<Uint8Array>)
}

async function relayError(upstream: Response, res: ServerResponse): Promise<ForwardResult> {
  const text = await upstream.text().catch(() => "")
  const status = upstream.status
  const headers: Record<string, string> = {}
  const retryAfter = upstream.headers.get("retry-after")
  if (retryAfter) headers["retry-after"] = retryAfter
  const message = withContextHint(upstreamMessage(text) || `Upstream returned HTTP ${status}`)
  sendError(res, status, errorTypeFor(status), message, headers)
  return { status }
}

async function post(
  url: string,
  headers: Record<string, string>,
  payload: unknown,
  signal: AbortSignal,
): Promise<Response> {
  try {
    return await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify(payload),
      signal,
    })
  } catch (error) {
    if (signal.aborted) throw error
    throw new HttpError(502, "api_error", `Could not reach ${new URL(url).host}: ${describeError(error)}`)
  }
}

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name]
  return Array.isArray(value) ? value[0] : value
}
