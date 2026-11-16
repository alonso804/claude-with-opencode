import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { RouteError, findModel, resolveRoute, usableModels } from "../../dist/catalog.js"
import { opencodeRef, resolveModelRef } from "../../dist/proxy.js"
import { prepareAnthropicBody } from "../../dist/translate/anthropic.js"
import { PLAIN_SIGNATURE } from "../../dist/message-builder.js"
import { contextWindow, modelPickerSettings, slotLabels } from "../../dist/picker.js"
import { providers } from "./helpers.mjs"

describe("resolveRoute", () => {
  it("picks the protocol and URL per model, as OpenCode Zen and Go mix them", () => {
    const all = providers()
    const claude = resolveRoute(all, "opencode/claude-sonnet-4-6")
    assert.equal(claude.protocol, "anthropic")
    assert.equal(claude.baseURL, "https://opencode.ai/inference/anthropic/v1")

    const gpt = resolveRoute(all, "opencode/gpt-5.5")
    assert.equal(gpt.protocol, "openai-responses")

    const glm = resolveRoute(all, "opencode-go/glm-5.3")
    assert.equal(glm.protocol, "openai-chat")
    assert.equal(glm.baseURL, "https://opencode.ai/inference/go/openai/v1")

    const minimax = resolveRoute(all, "opencode-go/minimax-m3")
    assert.equal(minimax.protocol, "anthropic")
    assert.equal(minimax.baseURL, "https://opencode.ai/inference/go/anthropic/v1")
  })

  it("allows models the catalog does not list yet, using provider defaults", () => {
    const route = resolveRoute(providers(), "opencode-go/brand-new")
    assert.equal(route.protocol, "openai-chat")
    assert.equal(route.upstreamModel, "brand-new")
  })

  it("rejects unknown providers, bad references and unsupported transports", () => {
    assert.throws(() => resolveRoute(providers(), "nope/x"), (error) => error instanceof RouteError && error.status === 404)
    assert.throws(() => resolveRoute(providers(), "glm-5.3"), (error) => error instanceof RouteError && error.status === 400)
    assert.throws(() => resolveRoute(providers(), "opencode/gemini-3.1-pro"), /@ai-sdk\/google/)
  })

  it("layers OpenCode config providers on top of the catalog", () => {
    const all = providers({
      local: {
        npm: "@ai-sdk/openai-compatible",
        baseURL: "http://localhost:11434/v1/",
        apiKey: "ollama",
        models: { qwen: { id: "qwen3:32b", name: "Qwen local" } },
      },
      "opencode-go": { baseURL: "http://127.0.0.1:9999/v1", headers: { "x-test": "1" }, models: {} },
    })
    const local = resolveRoute(all, "local/qwen")
    assert.equal(local.upstreamModel, "qwen3:32b")
    assert.equal(local.baseURL, "http://localhost:11434/v1")
    // A provider-level base URL beats the catalog's per-model one.
    const minimax = resolveRoute(all, "opencode-go/minimax-m3")
    assert.equal(minimax.baseURL, "http://127.0.0.1:9999/v1")
    assert.deepEqual(minimax.headers, { "x-test": "1" })
  })

  it("lists usable models newest first, without deprecated or unroutable ones", () => {
    const all = providers()
    assert.deepEqual(usableModels(all["opencode-go"]).map(([key]) => key), ["glm-5.3", "minimax-m3"])
    assert.deepEqual(usableModels(all.opencode).map(([key]) => key), ["gpt-5.5", "claude-sonnet-4-6"])
  })
})

describe("findModel", () => {
  it("finds a model typed without its provider, in provider order", () => {
    const all = providers()
    assert.equal(findModel(all, "glm-5.3", ["opencode", "opencode-go"]), "opencode-go/glm-5.3")
    assert.equal(findModel(all, "gpt-5.5[1m]", ["opencode-go", "opencode"]), "opencode/gpt-5.5")
    // Claude's own names, unknown models and unroutable ones are not OpenCode's.
    assert.equal(findModel(all, "claude-sonnet-4-6", ["opencode"]), undefined)
    assert.equal(findModel(all, "nope", ["opencode", "opencode-go"]), undefined)
    assert.equal(findModel(all, "gemini-3.1-pro", ["opencode"]), undefined)
    assert.equal(findModel(all, "glm-5.3", ["opencode"]), undefined)
  })
})

describe("picker", () => {
  it("sorts each provider's rows by name so a family stays together", () => {
    const all = providers({
      "opencode-go": {
        models: {
          "kimi-k3": { name: "Kimi K3", tool_call: true, release_date: "2026-07-16" },
          "glm-5.10": { name: "GLM-5.10", tool_call: true, release_date: "2026-01-01" },
        },
      },
    })
    const { modelPicker } = modelPickerSettings(all, { opencodeOnly: false }, ["opencode-go"])
    assert.deepEqual(modelPicker.options.map((row) => row.label), [
      "GLM-5.3 (OpenCode Go)",
      "GLM-5.10 (OpenCode Go)",
      "Kimi K3 (OpenCode Go)",
      "MiniMax-M3 (OpenCode Go)",
    ])
  })

  it("lists only pickerModels when set, in that order", () => {
    const all = providers()
    const { modelPicker } = modelPickerSettings(all, { opencodeOnly: false }, ["opencode-go", "opencode"], [
      "opencode/gpt-5.5",
      "opencode-go",
      "opencode/brand-new", // not in the catalog yet: still usable
      "nope/x", // unknown provider: skipped
      "opencode/gpt-5.5", // duplicate: once
    ])
    assert.deepEqual(modelPicker.options.map((row) => row.model), [
      "opencode/gpt-5.5",
      "opencode-go/glm-5.3",
      "opencode-go/minimax-m3",
      "opencode/brand-new",
    ])
  })

  it("adds connected providers' models after Claude's own rows, without OpenCode's anthropic", () => {
    const all = providers({ anthropic: { apiKey: "dummy", baseURL: "http://127.0.0.1:3456/v1", models: { "claude-x": {} } } })
    const { modelPicker } = modelPickerSettings(all, { opencodeOnly: false }, ["opencode-go", "anthropic"])
    assert.equal(modelPicker.replaceBuiltInOptions, false)
    assert.deepEqual(modelPicker.options.map((row) => row.model), ["opencode-go/glm-5.3", "opencode-go/minimax-m3"])
    assert.equal(modelPickerSettings(all, { opencodeOnly: false }, []), undefined)
  })

  it("with --oc-only, lists the slot providers' models instead of Claude's and labels the slots", () => {
    const all = providers()
    const defaults = { model: "opencode-go/glm-5.3", small: "opencode-go/minimax-m3", opencodeOnly: true }
    const { modelPicker } = modelPickerSettings(all, defaults)
    assert.equal(modelPicker.replaceBuiltInOptions, true)
    assert.deepEqual(modelPicker.options[0], {
      model: "opencode-go/glm-5.3",
      label: "GLM-5.3 (OpenCode Go)",
      description: "opencode-go/glm-5.3 · 1M context · chat",
    })
    assert.deepEqual(modelPicker.options.map((row) => row.model), ["opencode-go/glm-5.3", "opencode-go/minimax-m3"])
    assert.deepEqual(slotLabels(all, defaults), { model: "GLM-5.3 (OpenCode Go)", small: "MiniMax-M3 (OpenCode Go)" })
  })

  it("uses the smaller of the input and context limits", () => {
    assert.equal(contextWindow({ id: "x", limit: { context: 1050000, input: 922000, output: 128000 } }), 922000)
    assert.equal(contextWindow({ id: "x" }), undefined)
  })
})

describe("resolveModelRef", () => {
  const defaults = { model: "opencode-go/glm-5.3", small: "opencode-go/minimax-m3", opus: "opencode/gpt-5.5" }

  it("passes provider/model through and maps Claude names onto the slots", () => {
    assert.equal(resolveModelRef("opencode/claude-sonnet-4-6", defaults), "opencode/claude-sonnet-4-6")
    assert.equal(resolveModelRef("claude-haiku-4-5-20251001", defaults), "opencode-go/minimax-m3")
    assert.equal(resolveModelRef("claude-opus-4-8[1m]", defaults), "opencode/gpt-5.5")
    assert.equal(resolveModelRef("claude-sonnet-4-6", defaults), "opencode-go/glm-5.3")
    assert.equal(resolveModelRef("opencode-go/glm-5.3[1m]", defaults), "opencode-go/glm-5.3")
  })

  it("refuses bare names when there is no default", () => {
    assert.throws(() => resolveModelRef("claude-sonnet-4-6", {}), /not an OpenCode model/)
  })

  it("alongside Claude, treats only provider/model names as OpenCode's", () => {
    assert.equal(opencodeRef("opencode-go/glm-5.3[1m]"), "opencode-go/glm-5.3")
    assert.equal(opencodeRef("claude-opus-5-5"), undefined)
    assert.equal(opencodeRef("claude-opus-5-5[1m]"), undefined)
  })
})

describe("prepareAnthropicBody", () => {
  const request = {
    model: "opencode-go/minimax-m3",
    max_tokens: 200000,
    stream: true,
    thinking: { type: "adaptive" },
    context_management: { edits: [] },
    tools: [
      { name: "Bash", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } },
      { type: "web_search_20250305", name: "web_search" },
    ],
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "thinking", thinking: "x", signature: PLAIN_SIGNATURE }, { type: "text", text: "hello" }] },
    ],
  }

  it("keeps only portable fields for non-Claude models", () => {
    const body = prepareAnthropicBody(request, resolveRoute(providers(), "opencode-go/minimax-m3"))
    assert.equal(body.model, "minimax-m3")
    assert.equal(body.max_tokens, 131072)
    assert.equal(body.context_management, undefined)
    assert.equal(body.thinking, undefined)
    assert.deepEqual(body.tools, [{ name: "Bash", description: undefined, input_schema: { type: "object" } }])
    assert.deepEqual(body.messages[1].content, [{ type: "text", text: "hello" }])
  })

  it("forwards everything to Claude except translated thinking", () => {
    const body = prepareAnthropicBody({ ...request, model: "opencode/claude-sonnet-4-6" }, resolveRoute(providers(), "opencode/claude-sonnet-4-6"))
    assert.equal(body.model, "claude-sonnet-4-6")
    assert.deepEqual(body.context_management, { edits: [] })
    assert.deepEqual(body.thinking, { type: "adaptive" })
    assert.equal(body.tools.length, 2)
    assert.deepEqual(body.messages[1].content, [{ type: "text", text: "hello" }])
  })
})
