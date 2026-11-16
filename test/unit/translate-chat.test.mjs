import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { resolveRoute } from "../../dist/catalog.js"
import { MessageBuilder, PLAIN_SIGNATURE } from "../../dist/message-builder.js"
import { readSSE } from "../../dist/sse.js"
import { buildChatRequest, translateChatStream } from "../../dist/translate/chat.js"
import { ToolNames } from "../../dist/translate/common.js"
import { providers, recorder, silent, sseBytes } from "./helpers.mjs"

const glm = () => resolveRoute(providers(), "opencode-go/glm-5.3")

const conversation = {
  model: "opencode-go/glm-5.3",
  max_tokens: 500000,
  temperature: 1,
  system: [
    { type: "text", text: "You are Claude Code.", cache_control: { type: "ephemeral" } },
    { type: "text", text: "Be brief." },
  ],
  tools: [
    { name: "Bash", description: "Run a command", input_schema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: { command: { type: "string" } } } },
    { name: "mcp__my.server__look up", description: "MCP tool", input_schema: { type: "object", properties: {} } },
    { type: "web_search_20250305", name: "web_search" },
  ],
  messages: [
    { role: "user", content: "List the files" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "I should run ls.", signature: PLAIN_SIGNATURE },
        { type: "text", text: "Running ls." },
        { type: "tool_use", id: "call_1", name: "Bash", input: { command: "ls" } },
        { type: "tool_use", id: "call_2", name: "mcp__my.server__look up", input: {} },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_1", content: "a.txt\nb.txt" },
        { type: "tool_result", tool_use_id: "call_2", content: [{ type: "text", text: "found" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] },
        { type: "text", text: "Now summarize." },
      ],
    },
  ],
}

describe("buildChatRequest", () => {
  it("maps system, history, tool calls and tool results", () => {
    const names = new ToolNames()
    const body = buildChatRequest(conversation, glm(), names)

    assert.equal(body.model, "glm-5.3")
    assert.equal(body.stream, true)
    assert.deepEqual(body.stream_options, { include_usage: true })
    // Clamped to the catalog's output limit; temperature 1 is not forwarded.
    assert.equal(body.max_tokens, 131072)
    assert.equal(body.temperature, undefined)

    const [system, user, assistant, tool1, tool2, followUp] = body.messages
    assert.deepEqual(system, { role: "system", content: "You are Claude Code.\n\nBe brief." })
    assert.deepEqual(user, { role: "user", content: "List the files" })

    assert.equal(assistant.role, "assistant")
    assert.equal(assistant.content, "Running ls.")
    assert.equal(assistant.reasoning_content, "I should run ls.")
    assert.equal(assistant.tool_calls.length, 2)
    assert.deepEqual(assistant.tool_calls[0], {
      id: "call_1",
      type: "function",
      function: { name: "Bash", arguments: '{"command":"ls"}' },
    })
    const mcpName = assistant.tool_calls[1].function.name
    assert.match(mcpName, /^[a-zA-Z0-9_-]{1,64}$/)

    assert.deepEqual(tool1, { role: "tool", tool_call_id: "call_1", content: "a.txt\nb.txt" })
    assert.deepEqual(tool2, { role: "tool", tool_call_id: "call_2", content: "found" })
    // GLM-5.3 is text-only, so the tool's image becomes a placeholder.
    assert.equal(followUp.role, "user")
    assert.match(followUp.content, /\[image omitted/)
    assert.match(followUp.content, /Now summarize\./)
    assert.equal(body.messages.length, 6)

    // Server tools are dropped, $schema is stripped, names are consistent.
    assert.equal(body.tools.length, 2)
    assert.deepEqual(body.tools[0].function.parameters, { type: "object", properties: { command: { type: "string" } } })
    assert.equal(body.tools[1].function.name, mcpName)
    assert.equal(names.fromUpstream(mcpName), "mcp__my.server__look up")
  })

  it("drops Claude Code's attribution line, which would defeat the provider's prompt cache", () => {
    const route = glm()
    const attribution = "x-anthropic-billing-header: cc_version=2.1.310.c37; cc_entrypoint=cli;"
    const asBlocks = buildChatRequest(
      { model: "x", system: [{ type: "text", text: attribution }, { type: "text", text: "You are Claude Code." }], messages: [{ role: "user", content: "hi" }] },
      route,
      new ToolNames(),
    )
    assert.deepEqual(asBlocks.messages[0], { role: "system", content: "You are Claude Code." })
    const merged = buildChatRequest(
      { model: "x", system: `${attribution}\n\nYou are Claude Code.`, messages: [{ role: "user", content: "hi" }] },
      route,
      new ToolNames(),
    )
    assert.deepEqual(merged.messages[0], { role: "system", content: "You are Claude Code." })
  })

  it("maps tool_choice and reasoning effort", () => {
    const route = glm()
    const base = { model: "x", messages: [{ role: "user", content: "hi" }], tools: conversation.tools.slice(0, 1) }
    assert.equal(buildChatRequest({ ...base, tool_choice: { type: "any" } }, route, new ToolNames()).tool_choice, "required")
    assert.deepEqual(
      buildChatRequest({ ...base, tool_choice: { type: "tool", name: "Bash", disable_parallel_tool_use: true } }, route, new ToolNames()),
      {
        ...buildChatRequest(base, route, new ToolNames()),
        tool_choice: { type: "function", function: { name: "Bash" } },
        parallel_tool_calls: false,
      },
    )
    assert.equal(buildChatRequest(base, route, new ToolNames(), "high").reasoning_effort, "high")
    // Not in the model's allowed values.
    assert.equal(buildChatRequest(base, route, new ToolNames(), "medium").reasoning_effort, undefined)
    assert.equal(buildChatRequest({ ...base, temperature: 0.3 }, route, new ToolNames()).temperature, 0.3)
  })
})

async function translate(payloads, { names = new ToolNames(), model = "opencode-go/glm-5.3" } = {}) {
  const { events, emit } = recorder()
  const builder = new MessageBuilder(model, emit, 42)
  await translateChatStream(readSSE(sseBytes(payloads)), builder, names, silent)
  return { events, message: builder.message() }
}

describe("translateChatStream", () => {
  it("streams reasoning, text and buffered tool calls as Anthropic events", async () => {
    const names = new ToolNames()
    const mcp = names.toUpstream("mcp__my.server__look up")
    const { events, message } = await translate(
      [
        { choices: [{ delta: { role: "assistant", reasoning_content: "Thinking " } }] },
        { choices: [{ delta: { reasoning_content: "hard." } }] },
        { choices: [{ delta: { content: "Let me check." } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "Bash", arguments: "" } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 1, id: "call b", function: { name: mcp, arguments: "{}" } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"command":' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        { choices: [], usage: { prompt_tokens: 1200, completion_tokens: 80, prompt_tokens_details: { cached_tokens: 1000 } } },
        "[DONE]",
      ],
      { names },
    )

    assert.deepEqual(
      events.map((e) => (e.event === "content_block_delta" ? `delta:${e.data.delta.type}` : e.event)),
      [
        "message_start",
        "content_block_start",
        "delta:thinking_delta",
        "delta:thinking_delta",
        "delta:signature_delta",
        "content_block_stop",
        "content_block_start",
        "delta:text_delta",
        "content_block_stop",
        "content_block_start",
        "delta:input_json_delta",
        "content_block_stop",
        "content_block_start",
        "delta:input_json_delta",
        "content_block_stop",
        "message_delta",
        "message_stop",
      ],
    )
    assert.equal(events[0].data.message.usage.input_tokens, 42)

    assert.deepEqual(message.content, [
      { type: "thinking", thinking: "Thinking hard.", signature: PLAIN_SIGNATURE },
      { type: "text", text: "Let me check." },
      { type: "tool_use", id: "call_a", name: "Bash", input: { command: "ls" } },
      { type: "tool_use", id: "call_b", name: "mcp__my.server__look up", input: {} },
    ])
    assert.equal(message.stop_reason, "tool_use")
    assert.deepEqual(message.usage, { input_tokens: 200, output_tokens: 80, cache_read_input_tokens: 1000 })
    const delta = events.find((e) => e.event === "message_delta").data
    assert.equal(delta.delta.stop_reason, "tool_use")
    assert.equal(delta.usage.output_tokens, 80)
  })

  it("handles servers that omit tool call indexes and send object arguments", async () => {
    const { message } = await translate([
      { choices: [{ delta: { tool_calls: [{ id: "x1", function: { name: "Read", arguments: { file_path: "a" } } }] } }] },
      { choices: [{ delta: { tool_calls: [{ id: "x2", function: { name: "Read", arguments: '{"file_path":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ function: { arguments: '"b"}' } }] }, finish_reason: "stop" }] },
    ])
    assert.deepEqual(
      message.content.map((block) => block.input),
      [{ file_path: "a" }, { file_path: "b" }],
    )
    assert.equal(message.stop_reason, "tool_use")
  })

  it("maps length to max_tokens and surfaces in-stream errors", async () => {
    const { message } = await translate([{ choices: [{ delta: { content: "partial" }, finish_reason: "length" }] }])
    assert.equal(message.stop_reason, "max_tokens")
    await assert.rejects(translate([{ error: { message: "rate limited" } }]), /rate limited/)
  })

  it("accepts a whole non-streaming completion", async () => {
    const { events, emit } = recorder()
    const builder = new MessageBuilder("m", emit)
    const completion = {
      choices: [{ message: { content: "hello", reasoning_content: "hmm", tool_calls: [{ id: "t1", type: "function", function: { name: "Bash", arguments: "{}" } }] }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 10, completion_tokens: 3 },
    }
    async function* one() {
      yield { event: "json", data: JSON.stringify(completion) }
    }
    await translateChatStream(one(), builder, new ToolNames(), silent)
    assert.deepEqual(builder.message().content.map((b) => b.type), ["thinking", "text", "tool_use"])
    assert.equal(builder.message().usage.input_tokens, 10)
    assert.ok(events.length > 0)
  })
})
