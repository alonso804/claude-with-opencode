import type { IncomingMessage, ServerResponse } from "node:http"

import { isObject } from "./json.js"

/** An error answered in Anthropic's error format: `{ type: "error", error: { type, message } }`. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    message: string,
  ) {
    super(message)
  }
}

export function errorTypeFor(status: number): string {
  if (status === 400 || status === 422) return "invalid_request_error"
  if (status === 401) return "authentication_error"
  if (status === 402 || status === 403) return "permission_error"
  if (status === 404) return "not_found_error"
  if (status === 413) return "request_too_large"
  if (status === 429) return "rate_limit_error"
  if (status === 529) return "overloaded_error"
  return "api_error"
}

export function sendJSON(
  res: ServerResponse,
  status: number,
  data: unknown,
  headers: Record<string, string> = {},
): void {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body)),
    ...headers,
  })
  res.end(body)
}

export function sendError(
  res: ServerResponse,
  status: number,
  type: string,
  message: string,
  headers?: Record<string, string>,
): void {
  sendJSON(res, status, { type: "error", error: { type, message } }, headers)
}

const MAX_BODY_BYTES = 64 * 1024 * 1024

export async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "request_too_large", "Request body too large")
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

export function parseBody(raw: Buffer): unknown {
  try {
    return JSON.parse(raw.toString("utf8"))
  } catch {
    throw new HttpError(400, "invalid_request_error", "Request body is not valid JSON")
  }
}

/** The human-readable part of an upstream error body. */
export function upstreamMessage(text: string): string {
  try {
    const data = JSON.parse(text) as unknown
    if (isObject(data)) {
      const error = data.error
      const message =
        (isObject(error) && error.message) || (typeof error === "string" && error) || data.message || data.detail
      if (typeof message === "string" && message) return message
    }
  } catch {
    // not JSON
  }
  return text.trim().slice(0, 1000)
}

// Claude Code compacts the conversation when Anthropic says "prompt is too
// long". Other providers word it differently, so the phrase is added for them.
const CONTEXT_OVERFLOW =
  /context[_ ]length|context window|maximum context|too many (input )?tokens|exceeds? the (model'?s? )?(maximum|max)|prompt is too long/i

export function withContextHint(message: string): string {
  if (CONTEXT_OVERFLOW.test(message) && !/prompt is too long/i.test(message)) {
    return `prompt is too long: ${message}`
  }
  return message
}

export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const cause = (error as { cause?: unknown }).cause
  return cause instanceof Error ? `${error.message} (${cause.message})` : error.message
}
