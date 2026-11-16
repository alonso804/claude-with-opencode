import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { CredentialError, Credentials, parseAuthExport, parseAuthJson } from "../../dist/credentials.js"
import { providers, silent } from "./helpers.mjs"

// The shape `opencode auth export` prints on OpenCode 2.
const EXPORT = JSON.stringify([
  { id: "cred_1", integrationID: "mcp_abc", label: "x", active: true, value: { type: "oauth", refresh: "r", access: "a", expires: 1 } },
  { id: "cred_2", integrationID: "opencode", label: "OpenCode Zen", active: true, value: { type: "key", key: "zen-key" } },
  { id: "cred_3", integrationID: "opencode-go", label: "old", active: false, value: { type: "key", key: "stale" } },
  { id: "cred_4", integrationID: "opencode-go", label: "OpenCode Go", active: true, value: { type: "key", key: "go-key" } },
])

const missingFile = join(tmpdir(), "cwo-no-such-auth.json")

describe("parsers", () => {
  it("reads active API keys from opencode auth export and skips OAuth", () => {
    const keys = parseAuthExport(`some banner\n${EXPORT}\n`)
    assert.deepEqual([...keys], [["opencode", "zen-key"], ["opencode-go", "go-key"]])
    assert.throws(() => parseAuthExport("no json here"), /unexpected output/)
  })

  it("reads OpenCode 1.x auth.json", () => {
    const keys = parseAuthJson(JSON.stringify({ openai: { type: "api", key: "sk" }, github: { type: "oauth", refresh: "x" } }))
    assert.deepEqual([...keys], [["openai", "sk"]])
  })
})

describe("Credentials", () => {
  it("prefers config keys, then env vars, then OpenCode's store", async () => {
    let runs = 0
    const credentials = new Credentials({
      providers: providers({ custom: { apiKey: "from-config", models: {} } }),
      log: silent,
      env: {},
      authFile: missingFile,
      runExport: async () => {
        runs++
        return EXPORT
      },
    })
    assert.equal(await credentials.get("custom"), "from-config")
    assert.equal(await credentials.get("opencode-go"), "go-key")
    assert.equal(await credentials.get("opencode"), "zen-key")
    assert.equal(runs, 1, "the export runs once and is shared")

    const withEnv = new Credentials({
      providers: providers(),
      log: silent,
      env: { OPENCODE_API_KEY: " env-key " },
      authFile: missingFile,
      runExport: async () => assert.fail("export should not run"),
    })
    assert.equal(await withEnv.get("opencode-go"), "env-key")
  })

  it("falls back to OpenCode 1.x auth.json before running the export", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cwo-auth-"))
    const authFile = join(dir, "auth.json")
    writeFileSync(authFile, JSON.stringify({ "opencode-go": { type: "api", key: "legacy" } }))
    const credentials = new Credentials({
      providers: providers(),
      log: silent,
      env: {},
      authFile,
      runExport: async () => assert.fail("export should not run"),
    })
    assert.equal(await credentials.get("opencode-go"), "legacy")
  })

  it("explains what to do when a provider has no key, and does not hammer a failing export", async () => {
    let runs = 0
    const credentials = new Credentials({
      providers: providers(),
      log: silent,
      env: {},
      authFile: missingFile,
      runExport: async () => {
        runs++
        throw new Error("opencode is not on PATH")
      },
    })
    await assert.rejects(credentials.get("opencode-go"), (error) => error instanceof CredentialError && /OPENCODE_API_KEY/.test(error.message))
    await assert.rejects(credentials.get("opencode-go"), CredentialError)
    assert.equal(runs, 1)
    // Zen's free models work without a key, like in OpenCode.
    assert.equal(await credentials.get("opencode"), "public")
  })
})
