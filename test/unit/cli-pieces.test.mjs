import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { UsageError, claudeModelArg, parseArgs } from "../../dist/args.js"
import { parseJsonc } from "../../dist/json.js"
import { claudeEnvironment } from "../../dist/process.js"
import { resolveDefaults } from "../../dist/settings.js"
import { readSSE } from "../../dist/sse.js"

describe("parseArgs", () => {
  it("takes --oc-* options anywhere and passes everything else to claude", () => {
    const options = parseArgs(["-p", "--oc-model", "opencode-go/glm-5.3", "hello", "--oc-port=4000", "--model", "x/y", "--oc-serve"])
    assert.equal(options.model, "opencode-go/glm-5.3")
    assert.equal(options.port, 4000)
    assert.equal(options.serve, true)
    assert.deepEqual(options.claudeArgs, ["-p", "hello", "--model", "x/y"])
    assert.equal(claudeModelArg(options.claudeArgs), "x/y")
    assert.equal(claudeModelArg(["--model=a/b"]), "a/b")
  })

  it("rejects unknown or incomplete wrapper options", () => {
    assert.throws(() => parseArgs(["--oc-nope"]), UsageError)
    assert.throws(() => parseArgs(["--oc-model"]), UsageError)
    assert.throws(() => parseArgs(["--oc-port", "http"]), UsageError)
    assert.throws(() => parseArgs(["--oc-serve=yes"]), UsageError)
  })
})

describe("resolveDefaults", () => {
  const cli = (extra = {}) => ({ ...parseArgs([]), ...extra })
  const opencode = { model: "oc/from-opencode", smallModel: "oc/small" }

  it("orders flags, claude --model, env, then settings", () => {
    assert.equal(resolveDefaults({ cli: cli(), env: {}, settings: { model: "s/m" }, opencode }).model, "s/m")
    assert.equal(resolveDefaults({ cli: cli(), env: { CWO_MODEL: "e/m" }, settings: { model: "s/m" }, opencode }).model, "e/m")
    assert.equal(resolveDefaults({ cli: cli({ claudeArgs: ["--model", "c/m"] }), env: { CWO_MODEL: "e/m" }, settings: {}, opencode }).model, "c/m")
    assert.equal(resolveDefaults({ cli: cli({ model: "f/m" }), env: { CWO_MODEL: "e/m" }, settings: {}, opencode }).model, "f/m")
  })

  it("keeps Claude Code's own default unless OpenCode-only mode is on", () => {
    const hybrid = resolveDefaults({ cli: cli(), env: {}, settings: {}, opencode })
    assert.equal(hybrid.opencodeOnly, false)
    assert.equal(hybrid.model, undefined, "OpenCode's own default does not replace Claude's")
    assert.equal(hybrid.small, undefined)
    // A Claude alias passed to claude is not an OpenCode model either way.
    assert.equal(resolveDefaults({ cli: cli({ claudeArgs: ["--model", "opus"] }), env: {}, settings: {}, opencode }).model, undefined)

    for (const only of [
      { cli: cli({ opencodeOnly: true }), env: {}, settings: {} },
      { cli: cli(), env: { CWO_OPENCODE_ONLY: "1" }, settings: {} },
      { cli: cli(), env: {}, settings: { opencodeOnly: true } },
    ]) {
      const defaults = resolveDefaults({ ...only, opencode })
      assert.equal(defaults.opencodeOnly, true)
      assert.equal(defaults.model, "oc/from-opencode")
      assert.equal(defaults.small, "oc/small")
    }
    assert.equal(parseArgs(["--oc-only"]).opencodeOnly, true)
  })
})

describe("claudeEnvironment", () => {
  const base = {
    PATH: "/bin",
    ANTHROPIC_API_KEY: "sk-ant-real",
    ANTHROPIC_BASE_URL: "https://my-gateway.example",
    CLAUDE_CODE_USE_BEDROCK: "1",
  }

  it("alongside Claude, keeps the user's Claude login and changes only the chosen slots", () => {
    const env = claudeEnvironment(base, {
      baseURL: "http://127.0.0.1:5555/t0k",
      token: "t0k",
      defaults: { model: "a/main", small: "a/small", opencodeOnly: false },
      labels: { model: "Main (A)", small: "Small (A)" },
      contextWindow: 1000000,
    })
    assert.equal(env.PATH, "/bin")
    assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-real")
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined)
    assert.equal(env.CLAUDE_CODE_USE_BEDROCK, undefined)
    assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:5555/t0k")
    assert.equal(env.ANTHROPIC_MODEL, "a/main")
    assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "a/small")
    assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME, "Small (A)")
    // opus and sonnet stay Claude's.
    assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, undefined)
    assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, undefined)
    assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "1000000")
    // The proxy strips the attribution line for OpenCode itself.
    assert.equal(env.CLAUDE_CODE_ATTRIBUTION_HEADER, undefined)

    const plain = claudeEnvironment(base, { baseURL: "http://127.0.0.1:1/t", token: "t", defaults: { opencodeOnly: false } })
    assert.equal(plain.ANTHROPIC_MODEL, undefined)
    assert.equal(plain.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined)
  })

  it("with --oc-only, drops Anthropic credentials and fills every slot", () => {
    const options = {
      baseURL: "http://127.0.0.1:5555/t0k",
      token: "t0k",
      defaults: { model: "a/main", small: "a/small", opencodeOnly: true },
      labels: { model: "Main (A)", small: "Small (A)" },
      contextWindow: 1000000,
    }
    const env = claudeEnvironment(base, options)
    assert.equal(env.ANTHROPIC_API_KEY, undefined)
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, "t0k")
    assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, "a/main")
    assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, "a/main")
    assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "a/small")
    assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME, "Main (A)")
    assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME, "Small (A)")

    const mine = claudeEnvironment({ CLAUDE_CODE_MAX_CONTEXT_TOKENS: "500000" }, options)
    assert.equal(mine.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "500000")
  })
})

describe("parseJsonc", () => {
  it("accepts comments and trailing commas but leaves strings alone", () => {
    const value = parseJsonc(`{
      // line comment
      "url": "http://x//y", /* block */
      "list": [1, 2,],
      "text": "a,}",
    }`)
    assert.deepEqual(value, { url: "http://x//y", list: [1, 2], text: "a,}" })
  })
})

describe("readSSE", () => {
  it("handles CRLF split across chunks, multi-line data and comments", async () => {
    async function* chunks() {
      const encoder = new TextEncoder()
      for (const part of [": ping\r", "\nevent: a\r\ndata: 1\r", "\ndata: 2\r\n\r\n", "data: last"]) yield encoder.encode(part)
    }
    const messages = []
    for await (const message of readSSE(chunks())) messages.push(message)
    assert.deepEqual(messages, [{ event: "a", data: "1\n2" }, { event: undefined, data: "last" }])
  })
})
