import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { resolveRoute } from "../../dist/catalog.js"
import { MessageBuilder, PLAIN_SIGNATURE } from "../../dist/message-builder.js"
import { readSSE } from "../../dist/sse.js"
import { ToolNames } from "../../dist/translate/common.js"
import {
  buildResponsesRequest,
  decodeReasoning,
  encodeReasoning,
  translateResponsesStream,
} from "../../dist/translate/responses.js"
import { providers, recorder, silent, sseBytes } from "./helpers.mjs"

const gpt = () => resolveRoute(providers(), "opencode/gpt-5.5")

describe("buildResponsesRequest", () => {
  it("maps history to input items and replays this model's reasoning", () => {
    const route = gpt()
    const signature = encodeReasoning(route.ref, "rs_1", "ENCRYPTED")
    const body = buildResponsesRequest(
      {
        model: "opencode/gpt-5.5",
        max_tokens: 32000,
        system: "You are Claude Code.",
        tools: [{ name: "Read", description: "Read a file", input_schema: { type: "object", properties: { file_path: { type: "string" } } } }],
        messages: [
          { role: "user", content: [{ type: "text", text: "Read a.txt" }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "BBBB" } }] },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "Need the file.", signature },
              { type: "thinking", thinking: "from another model", signature: PLAIN_SIGNATURE },
              { type: "tool_use", id: "call_9", name: "Read", input: { file_path: "a.txt" } },
            ],
          },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "call_9", content: "hello" }] },
        ],
      },
      route,
      new ToolNames(),
      "max",
    )

    assert.equal(body.model, "gpt-5.5")
    assert.equal(body.store, false)
    assert.equal(body.instructions, "You are Claude Code.")
    assert.equal(body.max_output_tokens, 32000)
    assert.deepEqual(body.reasoning, { summary: "auto", effort: "xhigh" })
    assert.deepEqual(body.include, ["reasoning.encrypted_content"])
    assert.deepEqual(body.tools, [
      { type: "function", name: "Read", description: "Read a file", parameters: { type: "object", properties: { file_path: { type: "string" } } }, strict: false },
    ])
    assert.deepEqual(body.input, [
      {
        role: "user",
        content: [
          { type: "input_text", text: "Read a.txt" },
          { type: "input_image", image_url: "data:image/jpeg;base64,BBBB", detail: "auto" },
        ],
      },
      { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "Need the file." }], encrypted_content: "ENCRYPTED" },
      { type: "function_call", call_id: "call_9", name: "Read", arguments: '{"file_path":"a.txt"}' },
      { type: "function_call_output", call_id: "call_9", output: "hello" },
    ])
  })

  it("binds encrypted reasoning to the model that produced it", () => {
    const signature = encodeReasoning("opencode/gpt-5.5", "rs_2", "E")
    assert.deepEqual(decodeReasoning(signature, "opencode/gpt-5.5"), { id: "rs_2", encrypted: "E" })
    assert.equal(decodeReasoning(signature, "opencode/gpt-5.4"), undefined)
    assert.equal(decodeReasoning("anthropic-signature", "opencode/gpt-5.5"), undefined)
  })
})

describe("translateResponsesStream", () => {
  it("turns response events into thinking, text and tool_use blocks", async () => {
    const route = gpt()
    const { events, emit } = recorder()
    const builder = new MessageBuilder("opencode/gpt-5.5", emit)
    const stream = [
      { type: "response.created", response: { id: "resp_1" } },
      { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_9" } },
      { type: "response.reasoning_summary_part.added", summary_index: 0 },
      { type: "response.reasoning_summary_text.delta", delta: "Plan: " },
      { type: "response.reasoning_summary_part.added", summary_index: 1 },
      { type: "response.reasoning_summary_text.delta", delta: "read it." },
      { type: "response.output_item.done", item: { type: "reasoning", id: "rs_9", encrypted_content: "SECRET", summary: [] } },
      { type: "response.output_item.added", item: { type: "message", id: "msg_1" } },
      { type: "response.output_text.delta", delta: "Reading." },
      { type: "response.output_item.added", item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "Read", arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"file_path"' },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: ':"a.txt"}' },
      { type: "response.output_item.done", item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "Read" } },
      { type: "response.completed", response: { status: "completed", usage: { input_tokens: 900, output_tokens: 50, input_tokens_details: { cached_tokens: 600 } } } },
    ]
    await translateResponsesStream(readSSE(sseBytes(stream, { event: true })), builder, new ToolNames(), route, silent)

    const message = builder.message()
    assert.equal(message.content[0].type, "thinking")
    assert.equal(message.content[0].thinking, "Plan: \n\nread it.")
    assert.deepEqual(decodeReasoning(message.content[0].signature, route.ref), { id: "rs_9", encrypted: "SECRET" })
    assert.deepEqual(message.content[1], { type: "text", text: "Reading." })
    assert.deepEqual(message.content[2], { type: "tool_use", id: "call_1", name: "Read", input: { file_path: "a.txt" } })
    assert.equal(message.stop_reason, "tool_use")
    assert.deepEqual(message.usage, { input_tokens: 300, output_tokens: 50, cache_read_input_tokens: 600 })
    assert.equal(events.at(-1).event, "message_stop")
  })

  it("keeps opaque reasoning without a summary and reports truncation", async () => {
    const route = gpt()
    const builder = new MessageBuilder("m")
    const stream = [
      { type: "response.output_item.done", item: { type: "reasoning", id: "rs_x", encrypted_content: "E2", summary: [] } },
      { type: "response.output_text.delta", delta: "cut" },
      { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } },
    ]
    await translateResponsesStream(readSSE(sseBytes(stream)), builder, new ToolNames(), route, silent)
    const message = builder.message()
    assert.equal(message.content[0].type, "thinking")
    assert.equal(message.content[0].thinking, "")
    assert.ok(decodeReasoning(message.content[0].signature, route.ref))
    assert.equal(message.stop_reason, "max_tokens")
  })

  it("throws on response.failed", async () => {
    const builder = new MessageBuilder("m")
    const stream = [{ type: "response.failed", response: { error: { message: "quota exceeded" } } }]
    await assert.rejects(
      translateResponsesStream(readSSE(sseBytes(stream)), builder, new ToolNames(), gpt(), silent),
      /quota exceeded/,
    )
  })
})
