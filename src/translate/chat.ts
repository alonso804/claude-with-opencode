// Anthropic Messages <-> OpenAI Chat Completions (`/chat/completions`), the
// protocol behind most of OpenCode's catalog (`@ai-sdk/openai-compatible`).

import type { CatalogModel, Route } from "../catalog.js"
import { isObject, parseJSON } from "../json.js"
import type { LogFn } from "../logger.js"
import type { MessageBuilder } from "../message-builder.js"
import type { SSEMessage } from "../sse.js"
import type { ContentBlock, ImageBlock, MessagesRequest, StopReason, Usage } from "../types.js"
import {
  UpstreamError,
  acceptsInput,
  blocksOf,
  cleanSchema,
  documentText,
  flattenToolResult,
  functionTools,
  interleavedField,
  maxOutputTokens,
  mediaURL,
  omitted,
  reasoningEffort,
  systemText,
  temperatureOf,
  toolUseId,
  type ToolNames,
} from "./common.js"

type ChatPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }
type ChatMessage = { role: "system" | "user" | "assistant" | "tool"; [field: string]: unknown }

export function buildChatRequest(
  req: MessagesRequest,
  route: Route,
  names: ToolNames,
  effortOverride?: string,
): Record<string, unknown> {
  const model = route.model
  const messages: ChatMessage[] = []
  const system = systemText(req.system)
  if (system) messages.push({ role: "system", content: system })

  const reasoningField = interleavedField(model)
  for (const message of req.messages) {
    const blocks = blocksOf(message.content)
    if (message.role === "assistant") messages.push(assistantMessage(blocks, names, reasoningField))
    else messages.push(...userMessages(blocks, model))
  }

  const body: Record<string, unknown> = {
    model: route.upstreamModel,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  }
  const maxTokens = maxOutputTokens(req.max_tokens, model)
  if (maxTokens) body.max_tokens = maxTokens
  const temperature = temperatureOf(req, model)
  if (temperature !== undefined) body.temperature = temperature
  if (req.stop_sequences?.length) body.stop = req.stop_sequences.slice(0, 4)

  const tools = functionTools(req)
  if (tools.length && model.tool_call !== false) {
    body.tools = tools.map((tool) => ({
      type: "function",
      function: {
        name: names.toUpstream(tool.name),
        description: tool.description ?? "",
        parameters: cleanSchema(tool.input_schema),
      },
    }))
    const choice = req.tool_choice
    if (choice?.type === "any") body.tool_choice = "required"
    else if (choice?.type === "none") body.tool_choice = "none"
    else if (choice?.type === "tool" && choice.name) {
      body.tool_choice = { type: "function", function: { name: names.toUpstream(choice.name) } }
    }
    if (choice?.disable_parallel_tool_use) body.parallel_tool_calls = false
  }

  const effort = reasoningEffort(req, model, effortOverride)
  if (effort) body.reasoning_effort = effort
  return body
}

function assistantMessage(
  blocks: ContentBlock[],
  names: ToolNames,
  reasoningField: string | undefined,
): ChatMessage {
  let text = ""
  let reasoning = ""
  const toolCalls: unknown[] = []
  for (const block of blocks) {
    if (block.type === "text") text += block.text
    else if (block.type === "thinking") reasoning += block.thinking
    else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: { name: names.toUpstream(block.name), arguments: JSON.stringify(block.input ?? {}) },
      })
    }
  }

  const message: ChatMessage = { role: "assistant", content: text || (toolCalls.length ? null : "") }
  if (toolCalls.length) message.tool_calls = toolCalls
  // Interleaved-thinking models (Kimi, GLM, DeepSeek, ...) want the reasoning
  // that led to a tool call back on the same assistant message.
  if (reasoningField && (reasoning || toolCalls.length)) message[reasoningField] = reasoning
  return message
}

function userMessages(blocks: ContentBlock[], model: CatalogModel): ChatMessage[] {
  const out: ChatMessage[] = []
  const parts: ChatPart[] = []
  const images = acceptsInput(model, "image")

  for (const block of blocks) {
    switch (block.type) {
      case "tool_result": {
        // Tool results are their own messages and must directly follow the
        // assistant message that made the calls.
        const result = flattenToolResult(block)
        out.push({ role: "tool", tool_call_id: block.tool_use_id, content: result.text })
        for (const image of result.images) parts.push(imagePart(image, images))
        break
      }
      case "text":
        if (block.text) parts.push({ type: "text", text: block.text })
        break
      case "image":
        parts.push(imagePart(block, images))
        break
      case "document":
        parts.push({
          type: "text",
          text: documentText(block) ?? omitted(block.title ? `document "${block.title}"` : "document"),
        })
        break
    }
  }

  if (parts.length) {
    const textOnly = parts.every((part) => part.type === "text")
    out.push({
      role: "user",
      content: textOnly ? parts.map((part) => (part as { text: string }).text).join("\n\n") : parts,
    })
  }
  return out
}

function imagePart(block: ImageBlock, supported: boolean): ChatPart {
  const url = supported ? mediaURL(block.source, "image/png") : undefined
  return url ? { type: "image_url", image_url: { url } } : { type: "text", text: omitted("image") }
}

// ---------------------------------------------------------------------------
// Response stream
// ---------------------------------------------------------------------------

interface ChatToolCallDelta {
  index?: number
  id?: string
  function?: { name?: string; arguments?: unknown }
}

interface ChatDelta {
  content?: unknown
  reasoning_content?: unknown
  reasoning?: unknown
  tool_calls?: ChatToolCallDelta[]
}

interface ChatChunk {
  choices?: Array<{ delta?: ChatDelta; message?: ChatDelta; finish_reason?: string | null }>
  usage?: ChatUsage
  error?: unknown
}

interface ChatUsage {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  prompt_cache_hit_tokens?: number
}

/**
 * Streams text and reasoning as they arrive. Tool calls are buffered until the
 * end: providers interleave their argument fragments by index, while an
 * Anthropic stream can only have one block open at a time.
 */
export async function translateChatStream(
  events: AsyncIterable<SSEMessage>,
  builder: MessageBuilder,
  names: ToolNames,
  log: LogFn,
): Promise<void> {
  builder.start()
  const calls = new Map<number, { id: string; name: string; args: string }>()
  let finishReason: string | undefined
  let usage: Partial<Usage> | undefined

  for await (const event of events) {
    if (event.data === "[DONE]") break
    const chunk = parseJSON(event.data)
    if (!isObject(chunk)) continue
    const { choices, usage: chunkUsage, error } = chunk as ChatChunk
    if (error) throw new UpstreamError(errorText(error))
    if (chunkUsage) usage = chatUsage(chunkUsage)

    const choice = choices?.[0]
    if (!choice) continue
    // A non-streaming response (event "json") carries `message` instead of `delta`.
    const delta = choice.delta ?? choice.message ?? {}

    const reasoning = delta.reasoning_content ?? delta.reasoning
    if (typeof reasoning === "string") builder.thinking(reasoning)
    if (typeof delta.content === "string") builder.text(delta.content)

    for (const call of delta.tool_calls ?? []) {
      let index = typeof call.index === "number" ? call.index : undefined
      if (index === undefined) {
        // Some servers omit the index: a new id starts a call, anything else
        // continues the latest one.
        const isNew = call.id && ![...calls.values()].some((known) => known.id === call.id)
        index = isNew || calls.size === 0 ? calls.size : calls.size - 1
      }
      let entry = calls.get(index)
      if (!entry) calls.set(index, (entry = { id: "", name: "", args: "" }))
      if (call.id) entry.id = call.id
      if (call.function?.name) entry.name = call.function.name
      const args = call.function?.arguments
      if (typeof args === "string") entry.args += args
      else if (isObject(args)) entry.args = JSON.stringify(args)
    }

    if (choice.finish_reason) finishReason = choice.finish_reason
  }

  let toolCount = 0
  for (const index of [...calls.keys()].sort((a, b) => a - b)) {
    const call = calls.get(index)!
    if (!call.name) {
      log("warn", "Dropping a tool call that had no name")
      continue
    }
    if (!builder.toolUse(toolUseId(call.id), names.fromUpstream(call.name), call.args)) {
      log("warn", `Tool call ${call.name} had invalid JSON arguments; sent as {}`)
    }
    toolCount++
  }

  builder.finish(stopReason(finishReason, toolCount > 0), usage)
}

function stopReason(finish: string | undefined, sawTools: boolean): StopReason {
  if (finish === "length") return "max_tokens"
  if (sawTools) return "tool_use"
  if (finish === "content_filter") return "refusal"
  return "end_turn"
}

function chatUsage(usage: ChatUsage): Partial<Usage> {
  const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0
  const out: Partial<Usage> = {}
  // Anthropic counts cache reads separately from input tokens.
  if (typeof usage.prompt_tokens === "number") out.input_tokens = Math.max(0, usage.prompt_tokens - cached)
  if (typeof usage.completion_tokens === "number") out.output_tokens = usage.completion_tokens
  if (cached) out.cache_read_input_tokens = cached
  return out
}

function errorText(error: unknown): string {
  if (typeof error === "string") return error
  if (isObject(error) && typeof error.message === "string") return error.message
  return JSON.stringify(error)
}
