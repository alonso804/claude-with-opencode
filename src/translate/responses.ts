// Anthropic Messages <-> OpenAI Responses (`/responses`), which OpenCode uses
// for GPT models (`@ai-sdk/openai`), including Zen's and Go's.

import type { Route } from "../catalog.js"
import { isObject, parseJSON, type JsonObject } from "../json.js"
import type { LogFn } from "../logger.js"
import { SIGNATURE_PREFIX, type MessageBuilder } from "../message-builder.js"
import type { SSEMessage } from "../sse.js"
import type { ContentBlock, DocumentBlock, ImageBlock, MessagesRequest, Usage } from "../types.js"
import {
  UpstreamError,
  acceptsInput,
  blocksOf,
  cleanSchema,
  documentText,
  flattenToolResult,
  functionTools,
  maxOutputTokens,
  mediaURL,
  omitted,
  reasoningEffort,
  systemText,
  temperatureOf,
  toolUseId,
  type ToolNames,
} from "./common.js"

// OpenAI reasoning is opaque (`encrypted_content`). It rides along in the
// thinking block's signature, bound to the model that produced it, so the next
// request can hand it back statelessly (`store: false`).
const REASONING_PREFIX = `${SIGNATURE_PREFIX}responses:`

export function encodeReasoning(ref: string, id: string, encrypted: string): string {
  return REASONING_PREFIX + Buffer.from(JSON.stringify({ ref, id, encrypted })).toString("base64url")
}

export function decodeReasoning(
  signature: string | undefined,
  ref: string,
): { id: string; encrypted: string } | undefined {
  if (!signature?.startsWith(REASONING_PREFIX)) return undefined
  const value = parseJSON(
    Buffer.from(signature.slice(REASONING_PREFIX.length), "base64url").toString("utf8"),
  )
  if (!isObject(value) || value.ref !== ref) return undefined
  if (typeof value.id !== "string" || typeof value.encrypted !== "string") return undefined
  return { id: value.id, encrypted: value.encrypted }
}

export function buildResponsesRequest(
  req: MessagesRequest,
  route: Route,
  names: ToolNames,
  effortOverride?: string,
): Record<string, unknown> {
  const model = route.model
  const input: unknown[] = []

  for (const message of req.messages) {
    const blocks = blocksOf(message.content)
    if (message.role === "assistant") input.push(...assistantItems(blocks, route, names))
    else input.push(...userItems(blocks, route))
  }

  const body: Record<string, unknown> = {
    model: route.upstreamModel,
    input,
    stream: true,
    store: false,
  }
  const system = systemText(req.system)
  if (system) body.instructions = system
  const maxTokens = maxOutputTokens(req.max_tokens, model)
  if (maxTokens) body.max_output_tokens = Math.max(16, maxTokens)
  const temperature = temperatureOf(req, model)
  if (temperature !== undefined) body.temperature = temperature

  const tools = functionTools(req)
  if (tools.length && model.tool_call !== false) {
    body.tools = tools.map((tool) => ({
      type: "function",
      name: names.toUpstream(tool.name),
      description: tool.description ?? "",
      parameters: cleanSchema(tool.input_schema),
      strict: false,
    }))
    const choice = req.tool_choice
    if (choice?.type === "any") body.tool_choice = "required"
    else if (choice?.type === "none") body.tool_choice = "none"
    else if (choice?.type === "tool" && choice.name) {
      body.tool_choice = { type: "function", name: names.toUpstream(choice.name) }
    }
    if (choice?.disable_parallel_tool_use) body.parallel_tool_calls = false
  }

  if (model.reasoning) {
    const effort = reasoningEffort(req, model, effortOverride)
    body.reasoning = { summary: "auto", ...(effort && { effort }) }
    body.include = ["reasoning.encrypted_content"]
  }
  return body
}

function assistantItems(blocks: ContentBlock[], route: Route, names: ToolNames): unknown[] {
  const items: unknown[] = []
  let text = ""
  const flush = () => {
    if (text) items.push({ role: "assistant", content: text })
    text = ""
  }
  for (const block of blocks) {
    if (block.type === "text") text += block.text
    else if (block.type === "thinking") {
      // Reasoning from other models has no encrypted payload to give back.
      const reasoning = decodeReasoning(block.signature, route.ref)
      if (!reasoning) continue
      flush()
      items.push({
        type: "reasoning",
        id: reasoning.id,
        summary: block.thinking ? [{ type: "summary_text", text: block.thinking }] : [],
        encrypted_content: reasoning.encrypted,
      })
    } else if (block.type === "tool_use") {
      flush()
      items.push({
        type: "function_call",
        call_id: block.id,
        name: names.toUpstream(block.name),
        arguments: JSON.stringify(block.input ?? {}),
      })
    }
  }
  flush()
  return items
}

function userItems(blocks: ContentBlock[], route: Route): unknown[] {
  const items: unknown[] = []
  const content: unknown[] = []
  for (const block of blocks) {
    switch (block.type) {
      case "tool_result": {
        const result = flattenToolResult(block)
        items.push({ type: "function_call_output", call_id: block.tool_use_id, output: result.text })
        for (const image of result.images) content.push(inputImage(image, route))
        break
      }
      case "text":
        if (block.text) content.push({ type: "input_text", text: block.text })
        break
      case "image":
        content.push(inputImage(block, route))
        break
      case "document":
        content.push(inputDocument(block, route))
        break
    }
  }
  if (content.length) items.push({ role: "user", content })
  return items
}

function inputImage(block: ImageBlock, route: Route): unknown {
  const url = acceptsInput(route.model, "image") ? mediaURL(block.source, "image/png") : undefined
  return url
    ? { type: "input_image", image_url: url, detail: "auto" }
    : { type: "input_text", text: omitted("image") }
}

function inputDocument(block: DocumentBlock, route: Route): unknown {
  const text = documentText(block)
  if (text !== undefined) return { type: "input_text", text }
  const data = acceptsInput(route.model, "pdf") ? mediaURL(block.source, "application/pdf") : undefined
  if (data?.startsWith("data:")) {
    return { type: "input_file", filename: block.title ?? "document.pdf", file_data: data }
  }
  return { type: "input_text", text: omitted(block.title ? `document "${block.title}"` : "document") }
}

// ---------------------------------------------------------------------------
// Response stream
// ---------------------------------------------------------------------------

export async function translateResponsesStream(
  events: AsyncIterable<SSEMessage>,
  builder: MessageBuilder,
  names: ToolNames,
  route: Route,
  log: LogFn,
): Promise<void> {
  builder.start()
  const pending = new Map<string, { callID: string; name: string; args: string }>()
  let sawTool = false
  let response: JsonObject | undefined

  const finishItem = (item: JsonObject) => {
    if (item.type === "reasoning") {
      const encrypted = typeof item.encrypted_content === "string" ? item.encrypted_content : undefined
      builder.endThinking(
        encrypted && typeof item.id === "string" ? encodeReasoning(route.ref, item.id, encrypted) : undefined,
      )
    } else if (item.type === "function_call") {
      const known = typeof item.id === "string" ? pending.get(item.id) : undefined
      const name = str(item.name) ?? known?.name
      if (!name) return log("warn", "Dropping a function call that had no name")
      const args = str(item.arguments) ?? known?.args ?? ""
      if (!builder.toolUse(toolUseId(str(item.call_id) ?? known?.callID), names.fromUpstream(name), args)) {
        log("warn", `Function call ${name} had invalid JSON arguments; sent as {}`)
      }
      sawTool = true
    }
  }

  for await (const event of events) {
    const data = parseJSON(event.data)
    if (!isObject(data)) continue

    // A non-streaming response body: replay its output items.
    if (event.event === "json") {
      if (data.error) throw new UpstreamError(errorText(data.error))
      for (const item of Array.isArray(data.output) ? data.output : []) {
        if (!isObject(item)) continue
        if (item.type === "reasoning") builder.thinking(summaryText(item))
        if (item.type === "message") builder.text(messageText(item))
        finishItem(item)
      }
      response = data
      continue
    }

    const type = str(data.type) ?? event.event
    switch (type) {
      case "response.output_item.added": {
        const item = data.item
        if (isObject(item) && item.type === "function_call" && typeof item.id === "string") {
          pending.set(item.id, { callID: str(item.call_id) ?? "", name: str(item.name) ?? "", args: "" })
        }
        break
      }
      case "response.reasoning_summary_part.added":
        if (typeof data.summary_index === "number" && data.summary_index > 0) builder.thinking("\n\n")
        break
      case "response.reasoning_summary_text.delta":
        if (typeof data.delta === "string") builder.thinking(data.delta)
        break
      case "response.output_text.delta":
      case "response.refusal.delta":
        if (typeof data.delta === "string") builder.text(data.delta)
        break
      case "response.function_call_arguments.delta": {
        const call = typeof data.item_id === "string" ? pending.get(data.item_id) : undefined
        if (call && typeof data.delta === "string") call.args += data.delta
        break
      }
      case "response.output_item.done":
        if (isObject(data.item)) finishItem(data.item)
        break
      case "response.completed":
      case "response.incomplete":
        if (isObject(data.response)) response = data.response
        break
      case "response.failed": {
        const failed = isObject(data.response) ? data.response.error : undefined
        throw new UpstreamError(errorText(failed ?? "response failed"))
      }
      case "error":
        throw new UpstreamError(errorText(data.error ?? data))
    }
  }

  const incomplete = isObject(response?.incomplete_details) ? response.incomplete_details.reason : undefined
  const stop = incomplete === "max_output_tokens" ? "max_tokens" : sawTool ? "tool_use" : "end_turn"
  builder.finish(stop, isObject(response?.usage) ? responsesUsage(response.usage) : undefined)
}

function responsesUsage(usage: JsonObject): Partial<Usage> {
  const details = isObject(usage.input_tokens_details) ? usage.input_tokens_details : {}
  const cached = typeof details.cached_tokens === "number" ? details.cached_tokens : 0
  const out: Partial<Usage> = {}
  if (typeof usage.input_tokens === "number") out.input_tokens = Math.max(0, usage.input_tokens - cached)
  if (typeof usage.output_tokens === "number") out.output_tokens = usage.output_tokens
  if (cached) out.cache_read_input_tokens = cached
  return out
}

function summaryText(item: JsonObject): string {
  const parts = Array.isArray(item.summary) ? item.summary : []
  return parts
    .map((part) => (isObject(part) && typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n\n")
}

function messageText(item: JsonObject): string {
  const parts = Array.isArray(item.content) ? item.content : []
  return parts
    .map((part) => (isObject(part) && typeof part.text === "string" ? part.text : ""))
    .join("")
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

function errorText(error: unknown): string {
  if (typeof error === "string") return error
  if (isObject(error) && typeof error.message === "string") return error.message
  return JSON.stringify(error)
}
