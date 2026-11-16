import { timingSafeEqual } from "node:crypto"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

import { RouteError, findModel, resolveRoute, usableModels, type Providers, type Route } from "./catalog.js"
import { CredentialError, type Credentials } from "./credentials.js"
import { HttpError, describeError, parseBody, readBody, sendError, sendJSON } from "./http.js"
import { isObject } from "./json.js"
import type { LogFn } from "./logger.js"
import type { ModelDefaults } from "./settings.js"
import { withoutForeignThinking } from "./translate/anthropic.js"
import { estimateTokens } from "./translate/common.js"
import type { MessagesRequest } from "./types.js"
import { forward, relayToAnthropic } from "./upstream.js"

export interface ProxyOptions {
  /**
   * Requests prove they come from the Claude Code this proxy launched with a
   * `/<token>` path prefix (part of ANTHROPIC_BASE_URL), or with the token as
   * `x-api-key` / `Authorization: Bearer` (`--oc-only`).
   */
  token: string
  providers: Providers
  credentials: Credentials
  defaults: ModelDefaults
  log: LogFn
  port?: number
  /** Where Claude models go when Claude stays available. */
  anthropicURL?: string
  /** Providers searched, in order, for a model typed without its provider. */
  lookupOrder?: string[]
}

export interface ProxyHandle {
  port: number
  /** Origin of the proxy, e.g. `http://127.0.0.1:53001`. */
  url: string
  /** What Claude Code gets as ANTHROPIC_BASE_URL: the origin plus the token. */
  baseURL: string
  close(): Promise<void>
}

// Loopback only: the proxy spends your OpenCode credentials on behalf of
// whoever can reach it, and the token is the second lock on that door.
const HOST = "127.0.0.1"
export const ANTHROPIC_URL = "https://api.anthropic.com"

export async function startProxy(options: ProxyOptions): Promise<ProxyHandle> {
  const server = createServer((req, res) => {
    handle(req, res, options).catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 500
      const type = error instanceof HttpError ? error.type : "api_error"
      const where = `${req.method} ${publicPath(req.url, options.token)}`
      if (status >= 500) options.log("error", `${where}: ${describeError(error)}`)
      else options.log("warn", `${where}: ${status} ${describeError(error)}`)
      if (!res.headersSent) sendError(res, status, type, describeError(error))
      else res.end()
    })
  })

  const port = await listen(server, options.port ?? 0, options.log)
  const url = `http://${HOST}:${port}`
  return {
    port,
    url,
    baseURL: `${url}/${options.token}`,
    close: () => close(server),
  }
}

function listen(server: Server, port: number, log: LogFn): Promise<number> {
  const attempt = (wanted: number) =>
    new Promise<number>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening)
        reject(error)
      }
      const onListening = () => {
        server.off("error", onError)
        resolve((server.address() as AddressInfo).port)
      }
      server.once("error", onError)
      server.once("listening", onListening)
      server.listen(wanted, HOST)
    })

  return attempt(port).catch((error: NodeJS.ErrnoException) => {
    if (port === 0 || error.code !== "EADDRINUSE") throw error
    log("info", `Port ${port} is in use, using a free port instead`)
    return attempt(0)
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections()
  })
}

/** The request path without the token prefix: safe to log and to forward. */
function publicPath(url: string | undefined, token: string): string {
  const raw = url ?? "/"
  return raw === `/${token}` || raw.startsWith(`/${token}/`) || raw.startsWith(`/${token}?`)
    ? raw.slice(token.length + 1) || "/"
    : raw
}

async function handle(req: IncomingMessage, res: ServerResponse, options: ProxyOptions): Promise<void> {
  const method = req.method ?? "GET"
  const forwardPath = publicPath(req.url, options.token)
  const viaPrefix = forwardPath !== (req.url ?? "/")
  const path = new URL(forwardPath, "http://proxy").pathname.replace(/\/+$/, "") || "/"
  const trusted = viaPrefix || hasToken(req, options.token)
  const { opencodeOnly } = options.defaults

  // `/api/hello` is Claude Code's connection-warming probe.
  if ((method === "GET" || method === "HEAD") && (path === "/" || path === "/health" || path === "/api/hello")) {
    return sendJSON(res, 200, { status: "ok", service: "claude-with-opencode" })
  }

  const isMessages = method === "POST" && (path === "/v1/messages" || path === "/v1/messages/count_tokens")
  const raw = method === "GET" || method === "HEAD" ? undefined : await readBody(req)

  if (isMessages) {
    const body = parseBody(raw!) as MessagesRequest
    if (!isObject(body) || typeof body.model !== "string") {
      throw new HttpError(400, "invalid_request_error", "Expected a Messages API body with a model")
    }
    const find = (name: string) => findModel(options.providers, name, options.lookupOrder ?? [])
    const ref = opencodeOnly
      ? resolveModelRef(body.model, options.defaults, find)
      : (opencodeRef(body.model) ?? find(body.model))
    if (ref) {
      if (!trusted) throw new HttpError(401, "authentication_error", "Invalid proxy token")
      if (path.endsWith("/count_tokens")) return sendJSON(res, 200, { input_tokens: estimateTokens(body) })
      return handleMessages(req, res, options, body, ref)
    }
    // A Claude model: hand it to Anthropic untouched, except for thinking
    // that an OpenCode model produced earlier in the conversation.
    const cleaned = Array.isArray(body.messages) ? withoutForeignThinking(body) : body
    return relay(req, res, options, forwardPath, raw, cleaned === body ? undefined : cleaned, body.model)
  }

  if (!opencodeOnly) return relay(req, res, options, forwardPath, raw)

  if (!trusted) throw new HttpError(401, "authentication_error", "Invalid proxy token")
  if (method === "GET" && path === "/v1/models") return sendJSON(res, 200, modelList(options))
  throw new HttpError(404, "not_found_error", `No route for ${method} ${path}`)
}

async function relay(
  req: IncomingMessage,
  res: ServerResponse,
  options: ProxyOptions,
  path: string,
  raw: Buffer | undefined,
  rewritten?: unknown,
  model?: string,
): Promise<void> {
  const started = Date.now()
  const abort = abortOnClose(res)
  const { status, error } = await relayToAnthropic({
    method: req.method ?? "GET",
    path,
    incoming: req.headers,
    raw,
    rewritten,
    res,
    signal: abort.signal,
    anthropicURL: options.anthropicURL ?? ANTHROPIC_URL,
  })
  const what = model ?? `${req.method} ${new URL(path, "http://proxy").pathname}`
  options.log(
    error ? "warn" : "info",
    `${what} -> anthropic [passthrough] ${status} ${Date.now() - started}ms${error ? `: ${error}` : ""}`,
  )
}

async function handleMessages(
  req: IncomingMessage,
  res: ServerResponse,
  options: ProxyOptions,
  body: MessagesRequest,
  ref: string,
): Promise<void> {
  const started = Date.now()
  if (!Array.isArray(body.messages)) {
    throw new HttpError(400, "invalid_request_error", "Expected a Messages API body with model and messages")
  }

  let route: Route
  try {
    route = resolveRoute(options.providers, ref)
  } catch (error) {
    if (!(error instanceof RouteError)) throw error
    throw new HttpError(error.status, error.status === 404 ? "not_found_error" : "invalid_request_error", error.message)
  }

  let apiKey: string
  try {
    apiKey = await options.credentials.get(route.providerID)
  } catch (error) {
    if (!(error instanceof CredentialError)) throw error
    throw new HttpError(401, "authentication_error", error.message)
  }

  options.log(
    "debug",
    `${route.ref}: Claude Code asked for thinking=${body.thinking?.type ?? "-"} effort=${body.output_config?.effort ?? "-"} max_tokens=${body.max_tokens ?? "-"}`,
  )
  const abort = abortOnClose(res)
  const result = await forward({
    body,
    route,
    apiKey,
    incoming: req.headers,
    res,
    signal: abort.signal,
    log: options.log,
    effort: options.defaults.effort,
  })
  const usage = result.usage
    ? ` in=${result.usage.input_tokens + (result.usage.cache_read_input_tokens ?? 0)} out=${result.usage.output_tokens}`
    : ""
  options.log(
    "info",
    `${body.model} -> ${route.ref} [${route.protocol}] ${result.status} ${Date.now() - started}ms${usage}`,
  )
}

function abortOnClose(res: ServerResponse): AbortController {
  const abort = new AbortController()
  res.on("close", () => {
    if (!res.writableFinished) abort.abort()
  })
  return abort
}

/**
 * Alongside Claude, `provider/model` names are OpenCode's, and so are bare
 * names that one of your providers has (see findModel); the rest is Claude.
 */
export function opencodeRef(requested: string): string | undefined {
  const name = requested.replace(/\[[^\]]*\]$/, "").trim()
  return name.includes("/") ? name : undefined
}

/**
 * With `--oc-only`, everything is an OpenCode model. Claude Code still
 * sends its built-in Claude names from older settings or hard-coded
 * helpers; those map onto the slots.
 */
export function resolveModelRef(
  requested: string,
  defaults: ModelDefaults,
  find: (name: string) => string | undefined = () => undefined,
): string {
  const direct = opencodeRef(requested) ?? find(requested)
  if (direct) return direct
  const lower = requested.toLowerCase()
  const ref =
    (lower.includes("haiku") && defaults.small) ||
    (lower.includes("opus") && defaults.opus) ||
    (lower.includes("sonnet") && defaults.sonnet) ||
    defaults.model
  if (!ref) {
    throw new HttpError(
      400,
      "invalid_request_error",
      `"${requested}" is not an OpenCode model. Use provider/model, for example opencode-go/glm-5.3.`,
    )
  }
  return ref
}

function hasToken(req: IncomingMessage, token: string): boolean {
  const apiKey = req.headers["x-api-key"]
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "")
  const value = (Array.isArray(apiKey) ? apiKey[0] : apiKey) ?? bearer
  if (!value) return false
  const given = Buffer.from(value)
  const expected = Buffer.from(token)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

/** The models of the providers behind Claude Code's slots, Anthropic-style. */
function modelList(options: ProxyOptions) {
  const ids = new Set(
    [options.defaults.model, options.defaults.small, options.defaults.opus, options.defaults.sonnet]
      .filter((ref): ref is string => !!ref && ref.includes("/"))
      .map((ref) => ref.slice(0, ref.indexOf("/"))),
  )
  const data = []
  for (const id of ids) {
    const provider = options.providers[id]
    if (!provider) continue
    for (const [key, model] of usableModels(provider)) {
      const created = model.release_date ? new Date(model.release_date) : undefined
      data.push({
        type: "model",
        id: `${id}/${key}`,
        display_name: model.name ?? key,
        created_at: (created && !Number.isNaN(created.getTime()) ? created : new Date(0)).toISOString(),
      })
    }
  }
  return { data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null }
}
