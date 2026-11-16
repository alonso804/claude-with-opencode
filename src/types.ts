// The subset of Anthropic's Messages API that Claude Code sends and reads.

export interface TextBlock {
  type: "text"
  text: string
  cache_control?: unknown
}

export interface MediaSource {
  type: string
  media_type?: string
  data?: string
  url?: string
}

export interface ImageBlock {
  type: "image"
  source: MediaSource
}

export interface DocumentBlock {
  type: "document"
  source: MediaSource
  title?: string
}

export interface ToolUseBlock {
  type: "tool_use"
  id: string
  name: string
  input: unknown
}

export interface ToolResultBlock {
  type: "tool_result"
  tool_use_id: string
  content?: string | ContentBlock[]
  is_error?: boolean
}

export interface ThinkingBlock {
  type: "thinking"
  thinking: string
  signature?: string
}

export interface RedactedThinkingBlock {
  type: "redacted_thinking"
  data: string
}

export type ContentBlock =
  | TextBlock
  | ImageBlock
  | DocumentBlock
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock
  | RedactedThinkingBlock

export interface Message {
  role: "user" | "assistant"
  content: string | ContentBlock[]
}

export interface Tool {
  name: string
  description?: string
  input_schema?: Record<string, unknown>
  /** Set on Anthropic server tools (web search, code execution, ...). */
  type?: string
  [key: string]: unknown
}

export interface ToolChoice {
  type: "auto" | "any" | "tool" | "none"
  name?: string
  disable_parallel_tool_use?: boolean
}

export interface MessagesRequest {
  model: string
  messages: Message[]
  system?: string | TextBlock[]
  max_tokens?: number
  stream?: boolean
  temperature?: number
  top_p?: number
  top_k?: number
  stop_sequences?: string[]
  tools?: Tool[]
  tool_choice?: ToolChoice
  thinking?: { type: string; budget_tokens?: number }
  output_config?: { effort?: string; [key: string]: unknown }
  [key: string]: unknown
}

export type StopReason =
  | "end_turn"
  | "max_tokens"
  | "stop_sequence"
  | "tool_use"
  | "refusal"

export interface Usage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}
