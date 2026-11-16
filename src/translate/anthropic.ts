// Models that already speak Anthropic Messages (Claude on Zen, plus MiniMax
// and Qwen on Zen/Go) are forwarded almost untouched.

import type { Route } from "../catalog.js"
import { SIGNATURE_PREFIX } from "../message-builder.js"
import type { Message, MessagesRequest } from "../types.js"
import { functionTools, isClaudeRoute, maxOutputTokens, withoutAttribution } from "./common.js"

// The stable Messages API surface. Beta-only fields (context management,
// MCP servers, containers, ...) are left out for non-Claude models, whose
// Anthropic-compatible endpoints reject what they do not know.
const PORTABLE_FIELDS = new Set([
  "model",
  "messages",
  "system",
  "max_tokens",
  "metadata",
  "stop_sequences",
  "stream",
  "temperature",
  "top_p",
  "top_k",
  "tools",
  "tool_choice",
  "thinking",
])

export function prepareAnthropicBody(req: MessagesRequest, route: Route): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ...withoutForeignThinking(req),
    model: route.upstreamModel,
  }
  const system = withoutAttribution(req.system)
  if (system === undefined || (Array.isArray(system) && !system.length)) delete body.system
  else body.system = system
  const maxTokens = maxOutputTokens(req.max_tokens, route.model)
  if (maxTokens) body.max_tokens = maxTokens
  if (isClaudeRoute(route)) return body

  for (const key of Object.keys(body)) if (!PORTABLE_FIELDS.has(key)) delete body[key]

  const tools = functionTools(req).map(({ name, description, input_schema }) => ({
    name,
    description,
    input_schema,
  }))
  if (tools.length) body.tools = tools
  else {
    delete body.tools
    delete body.tool_choice
  }

  // "adaptive" thinking is Claude-only.
  if (req.thinking && req.thinking.type !== "enabled" && req.thinking.type !== "disabled") {
    delete body.thinking
  }
  return body
}

/**
 * Thinking this proxy translated from another provider carries no real
 * signature, and Anthropic rejects it. That matters on every Anthropic-bound
 * request, including Claude Code's own Claude models after a session switched
 * away from an OpenCode model. Returns the request unchanged when there is
 * nothing to remove.
 */
export function withoutForeignThinking(req: MessagesRequest): MessagesRequest {
  if (!req.messages.some(hasForeignThinking)) return req
  return { ...req, messages: req.messages.map(stripMessage) }
}

const isForeign = (block: { type: string; signature?: string }) =>
  block.type === "thinking" && !!block.signature?.startsWith(SIGNATURE_PREFIX)

function hasForeignThinking(message: Message): boolean {
  return Array.isArray(message.content) && message.content.some(isForeign)
}

function stripMessage(message: Message): Message {
  if (!hasForeignThinking(message)) return message
  const content = (message.content as Exclude<Message["content"], string>).filter((block) => !isForeign(block))
  return { ...message, content: content.length ? content : [{ type: "text", text: "(no content)" }] }
}
