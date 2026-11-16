import { randomBytes } from "node:crypto"

import { isObject } from "./json.js"
import type { ContentBlock, StopReason, TextBlock, ThinkingBlock, Usage } from "./types.js"

/**
 * Marks thinking blocks this proxy produced from another provider's
 * reasoning. They carry no Anthropic signature, so they must never be sent to
 * an Anthropic endpoint as if they did.
 */
export const SIGNATURE_PREFIX = "cwo:"
export const PLAIN_SIGNATURE = `${SIGNATURE_PREFIX}plain`

export type Emit = (event: string, data: unknown) => void

/**
 * Assembles an Anthropic assistant message from translated upstream output.
 * With an `emit` it streams the matching Messages API events as it goes;
 * either way `message()` returns the finished message for non-streaming calls.
 */
export class MessageBuilder {
  readonly id = `msg_${randomBytes(12).toString("hex")}`
  readonly content: ContentBlock[] = []
  stopReason: StopReason | null = null
  usage: Usage

  private open: { index: number; type: "text" | "thinking" } | undefined
  private started = false

  constructor(
    private readonly model: string,
    private readonly emit: Emit = () => {},
    inputTokensEstimate = 0,
  ) {
    this.usage = { input_tokens: inputTokensEstimate, output_tokens: 0 }
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.emit("message_start", {
      type: "message_start",
      message: {
        id: this.id,
        type: "message",
        role: "assistant",
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { ...this.usage },
      },
    })
  }

  text(delta: string): void {
    if (!delta) return
    const index = this.ensure("text")
    ;(this.content[index] as TextBlock).text += delta
    this.emit("content_block_delta", {
      type: "content_block_delta",
      index,
      delta: { type: "text_delta", text: delta },
    })
  }

  thinking(delta: string): void {
    if (!delta) return
    const index = this.ensure("thinking")
    ;(this.content[index] as ThinkingBlock).thinking += delta
    this.emit("content_block_delta", {
      type: "content_block_delta",
      index,
      delta: { type: "thinking_delta", thinking: delta },
    })
  }

  /**
   * Closes the open thinking block with `signature`. Reasoning that arrives
   * with an opaque payload but no visible text still gets an (empty) block,
   * so the payload makes the round trip through Claude Code's history.
   */
  endThinking(signature?: string): void {
    if (this.open?.type !== "thinking") {
      if (!signature) return
      this.ensure("thinking")
    }
    this.close(signature)
  }

  /** Emits a complete tool_use block. Returns false if the arguments were not valid JSON. */
  toolUse(id: string, name: string, argumentsJson: string): boolean {
    this.start()
    this.close()
    const parsed = parseArguments(argumentsJson)
    const index = this.content.length
    this.content.push({ type: "tool_use", id, name, input: parsed.value })
    this.emit("content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id, name, input: {} },
    })
    this.emit("content_block_delta", {
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(parsed.value) },
    })
    this.emit("content_block_stop", { type: "content_block_stop", index })
    return parsed.ok
  }

  finish(stopReason: StopReason, usage?: Partial<Usage>): void {
    this.start()
    this.close()
    this.stopReason = stopReason
    if (usage) {
      for (const [key, value] of Object.entries(usage)) {
        if (typeof value === "number") this.usage[key as keyof Usage] = value
      }
    }
    this.emit("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { ...this.usage },
    })
    this.emit("message_stop", { type: "message_stop" })
  }

  error(type: string, message: string): void {
    this.emit("error", { type: "error", error: { type, message } })
  }

  ping(): void {
    this.emit("ping", { type: "ping" })
  }

  message() {
    return {
      id: this.id,
      type: "message",
      role: "assistant",
      model: this.model,
      content: this.content,
      stop_reason: this.stopReason,
      stop_sequence: null,
      usage: this.usage,
    }
  }

  private ensure(type: "text" | "thinking"): number {
    this.start()
    if (this.open?.type === type) return this.open.index
    this.close()
    const index = this.content.length
    const block: ContentBlock =
      type === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "", signature: "" }
    this.content.push(block)
    this.open = { index, type }
    this.emit("content_block_start", {
      type: "content_block_start",
      index,
      content_block: { ...block },
    })
    return index
  }

  private close(signature?: string): void {
    if (!this.open) return
    const { index, type } = this.open
    if (type === "thinking") {
      const value = signature ?? PLAIN_SIGNATURE
      ;(this.content[index] as ThinkingBlock).signature = value
      this.emit("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "signature_delta", signature: value },
      })
    }
    this.emit("content_block_stop", { type: "content_block_stop", index })
    this.open = undefined
  }
}

function parseArguments(text: string): { ok: boolean; value: Record<string, unknown> } {
  if (!text.trim()) return { ok: true, value: {} }
  try {
    let value: unknown = JSON.parse(text)
    // Some models double-encode their arguments.
    if (typeof value === "string") value = JSON.parse(value)
    if (isObject(value)) return { ok: true, value }
  } catch {
    // fall through
  }
  return { ok: false, value: {} }
}
