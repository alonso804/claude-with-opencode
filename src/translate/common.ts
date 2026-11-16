import { createHash, randomBytes } from "node:crypto"

import type { CatalogModel, Route } from "../catalog.js"
import type {
  ContentBlock,
  DocumentBlock,
  ImageBlock,
  MediaSource,
  MessagesRequest,
  Tool,
  ToolResultBlock,
} from "../types.js"

/** An upstream failure discovered after the HTTP status was already 200. */
export class UpstreamError extends Error {}

export function blocksOf(content: string | ContentBlock[] | undefined): ContentBlock[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : []
  return Array.isArray(content) ? content : []
}

export function systemText(system: MessagesRequest["system"]): string | undefined {
  const blocks = withoutAttribution(system)
  if (!blocks) return undefined
  if (typeof blocks === "string") return blocks || undefined
  const text = blocks
    .filter((block) => block?.type === "text" && block.text)
    .map((block) => block.text)
    .join("\n\n")
  return text || undefined
}

// Claude Code starts the system prompt with
// `x-anthropic-billing-header: cc_version=2.1.310.c37; cc_entrypoint=...;`.
// The suffix changes per conversation. api.anthropic.com strips the line,
// but any other provider would see it first, and it defeats prefix caching.
const ATTRIBUTION = /^x-anthropic-billing-header:[^\n]*(\n+|$)/

/** The system prompt without Claude Code's attribution line, for non-Anthropic upstreams. */
export function withoutAttribution(system: MessagesRequest["system"]): MessagesRequest["system"] {
  if (typeof system === "string") return system.replace(ATTRIBUTION, "")
  if (!Array.isArray(system) || !system.length) return system
  const [first, ...rest] = system
  if (first?.type !== "text" || !ATTRIBUTION.test(first.text)) return system
  const remainder = first.text.replace(ATTRIBUTION, "")
  return remainder ? [{ ...first, text: remainder }, ...rest] : rest
}

/** Claude Code's custom tools; Anthropic server tools have no input schema. */
export function functionTools(req: MessagesRequest): Tool[] {
  return (req.tools ?? []).filter((tool) => tool.name && isSchema(tool.input_schema))
}

function isSchema(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export function cleanSchema(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = schema ?? {}
  return { type: "object", ...rest }
}

export function flattenToolResult(block: ToolResultBlock): { text: string; images: ImageBlock[] } {
  const content = block.content
  if (typeof content === "string") return { text: content, images: [] }
  const texts: string[] = []
  const images: ImageBlock[] = []
  for (const part of content ?? []) {
    if (part.type === "text") texts.push(part.text)
    else if (part.type === "image") images.push(part)
    else if (part.type === "document") texts.push(documentText(part) ?? omitted("document"))
  }
  return { text: texts.join("\n"), images }
}

export function mediaURL(source: MediaSource | undefined, fallbackType: string): string | undefined {
  if (source?.type === "base64" && source.data) {
    return `data:${source.media_type ?? fallbackType};base64,${source.data}`
  }
  if (source?.type === "url" && source.url) return source.url
  return undefined
}

export function acceptsInput(model: CatalogModel, kind: "image" | "pdf"): boolean {
  const input = model.modalities?.input
  if (input) return input.includes(kind)
  // Not in the catalog: try images, which most current models read.
  return kind === "image" && model.attachment !== false
}

export function documentText(block: DocumentBlock): string | undefined {
  if (block.source?.type !== "text" || typeof block.source.data !== "string") return undefined
  return block.title ? `${block.title}\n\n${block.source.data}` : block.source.data
}

export function omitted(what: string): string {
  return `[${what} omitted: the selected model cannot read it]`
}

export function maxOutputTokens(requested: number | undefined, model: CatalogModel): number | undefined {
  const limit = model.limit?.output
  if (requested === undefined) return limit
  return limit ? Math.min(requested, limit) : requested
}

/**
 * Claude Code sends temperature 1 whenever extended thinking is on, because
 * Anthropic requires it then. That is not a preference worth imposing on
 * models that ship their own tuned defaults.
 */
export function temperatureOf(req: MessagesRequest, model: CatalogModel): number | undefined {
  if (model.temperature === false || req.temperature === undefined || req.temperature === 1) {
    return undefined
  }
  return req.temperature
}

export function reasoningEffort(
  req: MessagesRequest,
  model: CatalogModel,
  override?: string,
): string | undefined {
  if (model.reasoning === false) return undefined
  const wanted = override ?? req.output_config?.effort
  if (!wanted) return undefined
  const allowed = model.reasoning_options?.find((option) => option.type === "effort")?.values
  // Without catalog data only an explicit setting is trusted.
  if (!allowed) return override
  if (allowed.includes(wanted)) return wanted
  if (wanted === "max" && allowed.includes("xhigh")) return "xhigh"
  return undefined
}

/** The Chat Completions message field a model wants its earlier reasoning in. */
export function interleavedField(model: CatalogModel): "reasoning_content" | "reasoning" | undefined {
  const field = typeof model.interleaved === "object" ? model.interleaved.field : undefined
  return field === "reasoning_content" || field === "reasoning" ? field : undefined
}

export function isClaudeRoute(route: Route): boolean {
  return route.upstreamModel.startsWith("claude-") || (route.model.family ?? "").startsWith("claude")
}

/**
 * OpenAI-style APIs only accept tool names matching ^[a-zA-Z0-9_-]{1,64}$.
 * Names that do not fit are rewritten for the upstream and mapped back on the
 * way out, so Claude Code always sees its own names.
 */
export class ToolNames {
  private readonly upstream = new Map<string, string>()
  private readonly original = new Map<string, string>()

  toUpstream(name: string): string {
    const known = this.upstream.get(name)
    if (known) return known
    let candidate = name.replace(/[^a-zA-Z0-9_-]/g, "_")
    const taken = this.original.get(candidate)
    if (!candidate || candidate.length > 64 || (taken !== undefined && taken !== name)) {
      const hash = createHash("sha1").update(name).digest("hex").slice(0, 8)
      candidate = `${candidate.slice(0, 55)}_${hash}`
    }
    this.upstream.set(name, candidate)
    this.original.set(candidate, name)
    return candidate
  }

  fromUpstream(name: string): string {
    return this.original.get(name) ?? name
  }
}

/** Anthropic tool_use ids must match ^[a-zA-Z0-9_-]+$. */
export function toolUseId(id: string | undefined): string {
  const clean = (id ?? "").replace(/[^a-zA-Z0-9_-]/g, "_")
  return clean || `toolu_${randomBytes(12).toString("hex")}`
}

/** Rough count for count_tokens and message_start; upstream usage replaces it. */
export function estimateTokens(req: Partial<MessagesRequest>): number {
  let media = 0
  const text = JSON.stringify([req.system ?? "", req.messages ?? [], req.tools ?? []], (key, value) => {
    if (key === "data" && typeof value === "string" && value.length > 1024) {
      media++
      return ""
    }
    return value
  })
  return Math.ceil(text.length / 4) + media * 1600
}
