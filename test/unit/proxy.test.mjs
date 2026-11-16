import assert from "node:assert/strict"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, describe, it } from "node:test"

import { Credentials } from "../../dist/credentials.js"
import { PLAIN_SIGNATURE } from "../../dist/message-builder.js"
import { startProxy } from "../../dist/proxy.js"
import { fakeUpstream, parseAnthropicSSE, providers, silent, writeSSE } from "./helpers.mjs"

const TOKEN = "test-token"

describe("proxy alongside Claude", () => {
  let anthropic
  let opencode
  let proxy

  before(async () => {
    // Stands in for api.anthropic.com: echoes what reached it.
    anthropic = await fakeUpstream({
      "/v1/messages": (req, res) => {
        res.writeHead(200, { "content-type": "application/json", "request-id": "req_claude" })
        res.end(JSON.stringify({ id: "msg_c", type: "message", role: "assistant", model: req.body.model, content: [{ type: "text", text: "from claude" }] }))
      },
      "/v1/messages/count_tokens": (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ input_tokens: 4242 }))
      },
      "/v1/models": (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ data: [{ id: "claude-opus-5-5" }] }))
      },
    })
    opencode = await fakeUpstream({
      "/chat/completions": (_req, res) => writeSSE(res, [{ choices: [{ delta: { content: "from glm" }, finish_reason: "stop" }] }, "[DONE]"]),
    })
    const all = providers({ "opencode-go": { baseURL: opencode.url, models: {} } })
    proxy = await startProxy({
      token: TOKEN,
      providers: all,
      credentials: new Credentials({
        providers: all,
        log: silent,
        env: { OPENCODE_API_KEY: "upstream-key" },
        authFile: join(tmpdir(), "cwo-no-such-auth.json"),
      }),
      defaults: { opencodeOnly: false },
      log: silent,
      anthropicURL: anthropic.url,
      lookupOrder: ["opencode-go"],
    })
  })

  after(async () => {
    await proxy?.close()
    await anthropic?.close()
    await opencode?.close()
  })

  // What Claude Code does with ANTHROPIC_BASE_URL=<proxy>/<token> and its own login.
  const claude = (path, body, headers = {}) =>
    fetch(`${proxy.baseURL}${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer claude-oauth-token",
        "anthropic-beta": "oauth-2025-04-20,interleaved-thinking-2025-05-14",
        ...headers,
      },
      body: body && (typeof body === "string" ? body : JSON.stringify(body)),
    })

  it("relays Claude models to Anthropic untouched, the user's login included", async () => {
    const raw = '{"model":"claude-opus-5-5","max_tokens":5,   "messages":[{"role":"user","content":"hi"}]}'
    const res = await claude("/v1/messages?beta=true", raw)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get("request-id"), "req_claude")
    assert.equal((await res.json()).content[0].text, "from claude")

    const sent = anthropic.requests.at(-1)
    assert.equal(sent.url, "/v1/messages?beta=true", "the token prefix is not forwarded")
    assert.equal(sent.headers.authorization, "Bearer claude-oauth-token")
    assert.equal(sent.headers["anthropic-beta"], "oauth-2025-04-20,interleaved-thinking-2025-05-14")
    assert.equal(JSON.stringify(sent.body), JSON.stringify(JSON.parse(raw)))
    assert.equal(opencode.requests.length, 0)
  })

  it("removes thinking an OpenCode model produced before the session switched to Claude", async () => {
    await claude("/v1/messages", {
      model: "claude-sonnet-5-5",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "thinking", thinking: "glm thoughts", signature: PLAIN_SIGNATURE }, { type: "text", text: "hello" }] },
        { role: "user", content: "and now?" },
      ],
    })
    assert.deepEqual(anthropic.requests.at(-1).body.messages[1].content, [{ type: "text", text: "hello" }])
  })

  it("sends provider/model requests to OpenCode, never to Anthropic", async () => {
    const res = await claude("/v1/messages", { model: "opencode-go/glm-5.3", messages: [{ role: "user", content: "hi" }] })
    assert.equal(res.status, 200)
    assert.deepEqual((await res.json()).content, [{ type: "text", text: "from glm" }])
    const sent = opencode.requests.at(-1)
    assert.equal(sent.headers.authorization, "Bearer upstream-key", "the Claude login does not leak to OpenCode")
  })

  it("routes a model typed without its provider (/model glm-5.3) to OpenCode", async () => {
    const before = anthropic.requests.length
    const res = await claude("/v1/messages", { model: "glm-5.3", messages: [{ role: "user", content: "hi" }] })
    assert.equal(res.status, 200)
    assert.deepEqual((await res.json()).content, [{ type: "text", text: "from glm" }])
    assert.equal(opencode.requests.at(-1).body.model, "glm-5.3")
    assert.equal(anthropic.requests.length, before)
  })

  it("serves OpenCode models only to callers with the token", async () => {
    const res = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer claude-oauth-token" },
      body: JSON.stringify({ model: "opencode-go/glm-5.3", messages: [{ role: "user", content: "hi" }] }),
    })
    assert.equal(res.status, 401)
  })

  it("relays Claude's other endpoints and counts OpenCode tokens locally", async () => {
    assert.deepEqual(await (await claude("/v1/models")).json(), { data: [{ id: "claude-opus-5-5" }] })
    const claudeCount = await claude("/v1/messages/count_tokens", { model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }] })
    assert.equal((await claudeCount.json()).input_tokens, 4242)
    const ocCount = await claude("/v1/messages/count_tokens", { model: "opencode-go/glm-5.3", messages: [{ role: "user", content: "hi" }] })
    assert.notEqual((await ocCount.json()).input_tokens, 4242)
  })
})

describe("proxy with --oc-only", () => {
  let upstream
  let proxy

  before(async () => {
    upstream = await fakeUpstream({
      "/chat/completions": (req, res) => {
        if (req.body.messages.at(-1).content === "rate limit me") {
          res.writeHead(429, { "content-type": "application/json", "retry-after": "7" })
          return res.end(JSON.stringify({ error: { message: "slow down" } }))
        }
        if (req.body.messages.at(-1).content === "too long") {
          res.writeHead(400, { "content-type": "application/json" })
          return res.end(JSON.stringify({ error: { message: "This model's maximum context length is 1000 tokens" } }))
        }
        writeSSE(res, [
          { choices: [{ delta: { content: "Hi " } }] },
          { choices: [{ delta: { content: "there" }, finish_reason: "stop" }] },
          { choices: [], usage: { prompt_tokens: 12, completion_tokens: 2 } },
          "[DONE]",
        ])
      },
      "/responses": (_req, res) =>
        writeSSE(
          res,
          [
            { type: "response.output_text.delta", delta: "gpt says hi" },
            { type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 3 } } },
          ],
          { named: true },
        ),
      "/messages": (req, res) => {
        res.writeHead(200, { "content-type": "application/json", "request-id": "req_123" })
        res.end(JSON.stringify({ id: "msg_up", type: "message", role: "assistant", model: req.body.model, content: [{ type: "text", text: "anthropic passthrough" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }))
      },
    })

    // Every route points at the fake upstream; the catalog decides the protocol.
    const all = providers({
      opencode: { baseURL: upstream.url, models: {} },
      "opencode-go": { baseURL: upstream.url, models: {} },
    })
    proxy = await startProxy({
      token: TOKEN,
      providers: all,
      credentials: new Credentials({
        providers: all,
        log: silent,
        env: { OPENCODE_API_KEY: "upstream-key" },
        authFile: join(tmpdir(), "cwo-no-such-auth.json"),
      }),
      defaults: { model: "opencode-go/glm-5.3", small: "opencode/gpt-5.5", opencodeOnly: true },
      log: silent,
    })
  })

  after(async () => {
    await proxy?.close()
    await upstream?.close()
  })

  const call = (path, body, headers = { "x-api-key": TOKEN }) =>
    fetch(`${proxy.url}${path}`, {
      method: body ? "POST" : "GET",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", ...headers },
      body: body && JSON.stringify(body),
    })

  it("answers health checks and rejects requests without the token", async () => {
    assert.equal((await call("/health", undefined, {})).status, 200)
    const res = await call("/v1/messages", { model: "x", messages: [] }, { "x-api-key": "wrong" })
    assert.equal(res.status, 401)
    assert.equal((await res.json()).error.type, "authentication_error")
  })

  it("streams a chat-completions model as Anthropic SSE", async () => {
    const res = await call("/v1/messages?beta=true", {
      model: "opencode-go/glm-5.3",
      max_tokens: 100,
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    }, { authorization: `Bearer ${TOKEN}` })
    assert.equal(res.status, 200)
    assert.match(res.headers.get("content-type"), /text\/event-stream/)
    const events = parseAnthropicSSE(await res.text())
    assert.deepEqual(events.map((e) => e.event), [
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ])
    assert.equal(events.at(-2).data.usage.input_tokens, 12)

    const sent = upstream.requests.at(-1)
    assert.equal(sent.url, "/chat/completions")
    assert.equal(sent.headers.authorization, "Bearer upstream-key")
    assert.equal(sent.body.model, "glm-5.3")
  })

  it("identifies itself and passes Claude Code's session on, as OpenCode Go requires", async () => {
    await call("/v1/messages", { model: "opencode-go/glm-5.3", messages: [{ role: "user", content: "hello" }] }, {
      "x-api-key": TOKEN,
      "user-agent": "claude-cli/2.1.310 (external, cli)",
      "x-claude-code-session-id": "sess-1",
      "x-claude-code-agent-id": "agent-7",
    })
    const sent = upstream.requests.at(-1)
    assert.match(sent.headers["user-agent"], /^claude-with-opencode\/\d+\.\d+\.\d+ \(claude-cli\/2\.1\.310 \(external, cli\)\)$/)
    assert.equal(sent.headers["x-opencode-session"], "sess-1:agent-7")
    assert.equal(sent.headers["x-claude-code-session-id"], "sess-1")

    await call("/v1/messages", { model: "opencode-go/minimax-m3", messages: [{ role: "user", content: "hi" }] }, {
      "x-api-key": TOKEN,
      "x-claude-code-session-id": "sess-2",
    })
    assert.equal(upstream.requests.at(-1).headers["x-opencode-session"], "sess-2")
  })

  it("maps Claude's haiku requests to the small model and returns JSON when not streaming", async () => {
    const res = await call("/v1/messages", {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 100,
      messages: [{ role: "user", content: "title please" }],
    })
    assert.equal(res.status, 200)
    const message = await res.json()
    assert.equal(message.model, "claude-haiku-4-5-20251001")
    assert.deepEqual(message.content, [{ type: "text", text: "gpt says hi" }])
    assert.equal(upstream.requests.at(-1).url, "/responses")
    assert.equal(upstream.requests.at(-1).body.model, "gpt-5.5")
  })

  it("passes Anthropic-protocol models through with the upstream key", async () => {
    const res = await call("/v1/messages", {
      model: "opencode-go/minimax-m3",
      max_tokens: 100,
      context_management: {},
      messages: [{ role: "user", content: "hi" }],
    }, { "x-api-key": TOKEN, "anthropic-beta": "context-management-2025-06-27" })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get("request-id"), "req_123")
    assert.equal((await res.json()).content[0].text, "anthropic passthrough")
    const sent = upstream.requests.at(-1)
    assert.equal(sent.headers["x-api-key"], "upstream-key")
    assert.equal(sent.headers["anthropic-beta"], undefined)
    assert.equal(sent.body.context_management, undefined)
    assert.equal(sent.body.model, "minimax-m3")
  })

  it("relays upstream errors in Anthropic's format, keeping retry hints", async () => {
    const limited = await call("/v1/messages", { model: "opencode-go/glm-5.3", stream: true, messages: [{ role: "user", content: "rate limit me" }] })
    assert.equal(limited.status, 429)
    assert.equal(limited.headers.get("retry-after"), "7")
    assert.deepEqual(await limited.json(), { type: "error", error: { type: "rate_limit_error", message: "slow down" } })

    const long = await call("/v1/messages", { model: "opencode-go/glm-5.3", messages: [{ role: "user", content: "too long" }] })
    assert.equal(long.status, 400)
    assert.match((await long.json()).error.message, /^prompt is too long: /)
  })

  it("reports unknown models and unsupported transports clearly", async () => {
    const unknown = await call("/v1/messages", { model: "nope/x", messages: [{ role: "user", content: "hi" }] })
    assert.equal(unknown.status, 404)
    assert.equal((await unknown.json()).error.type, "not_found_error")

    const gemini = await call("/v1/messages", { model: "opencode/gemini-3.1-pro", messages: [{ role: "user", content: "hi" }] })
    assert.equal(gemini.status, 400)
    assert.match((await gemini.json()).error.message, /cannot translate/)
  })

  it("estimates tokens and lists the slot providers' models", async () => {
    const count = await call("/v1/messages/count_tokens", { model: "x", messages: [{ role: "user", content: "a".repeat(400) }] })
    assert.ok((await count.json()).input_tokens >= 100)

    const models = await (await call("/v1/models")).json()
    const ids = models.data.map((model) => model.id)
    assert.ok(ids.includes("opencode-go/glm-5.3"))
    assert.ok(ids.includes("opencode/gpt-5.5"))
    assert.ok(!ids.includes("opencode/gemini-3.1-pro"))
  })
})
