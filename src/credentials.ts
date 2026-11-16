import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import type { Providers } from "./catalog.js"
import { isObject } from "./json.js"
import type { LogFn } from "./logger.js"
import { opencodeDataDir } from "./paths.js"
import { captureOutput, findExecutable } from "./process.js"

export class CredentialError extends Error {}

const EXPORT_RETRY_MS = 30_000

export interface CredentialOptions {
  providers: Providers
  log: LogFn
  env?: NodeJS.ProcessEnv
  /** OpenCode 1.x keeps API keys in `~/.local/share/opencode/auth.json`. */
  authFile?: string
  /** Returns the stdout of OpenCode 2's `opencode auth export`. */
  runExport?: () => Promise<string>
}

/**
 * API keys for the providers you connected in OpenCode. Secrets stay in this
 * process's memory: they are never logged and never written anywhere.
 *
 * Lookup order per provider: the provider's `apiKey` in your OpenCode config,
 * its environment variables (e.g. `OPENCODE_API_KEY`), OpenCode 1.x's
 * auth.json, then OpenCode 2's `opencode auth export`.
 */
export class Credentials {
  /** Called right before the (slow) export runs, so a CLI can say why it waits. */
  onExport?: () => void

  /** Whether the last `opencode auth export` failed, so its absence of keys means nothing. */
  get exportFailed(): boolean {
    return Number.isFinite(this.failedAt)
  }

  private exported?: Promise<Map<string, string>>
  private failedAt = -Infinity
  private legacy?: Map<string, string>

  constructor(private readonly options: CredentialOptions) {}

  /** Starts the lookup early, so its latency overlaps Claude Code's startup. */
  prefetch(providerID: string): void {
    this.find(providerID).catch(() => {})
  }

  async find(providerID: string): Promise<string | undefined> {
    const provider = this.options.providers[providerID]
    if (provider?.apiKey) return provider.apiKey

    const env = this.options.env ?? process.env
    for (const name of provider?.env ?? []) {
      const value = env[name]?.trim()
      if (value) return value
    }

    return this.readLegacy().get(providerID) ?? (await this.readExport()).get(providerID)
  }

  async get(providerID: string): Promise<string> {
    const key = await this.find(providerID)
    if (key) return key
    // OpenCode itself sends this for Zen's free models when no key is set.
    if (providerID === "opencode") return "public"
    const names = this.options.providers[providerID]?.env ?? []
    throw new CredentialError(
      `No API key for provider "${providerID}". Connect it in OpenCode (opencode auth login)` +
        (names.length ? ` or set ${names.join(" / ")}.` : "."),
    )
  }

  private readLegacy(): Map<string, string> {
    if (this.legacy) return this.legacy
    this.legacy = new Map()
    const file = this.options.authFile ?? join(opencodeDataDir(), "auth.json")
    let text: string
    try {
      text = readFileSync(file, "utf8")
    } catch {
      return this.legacy
    }
    try {
      this.legacy = parseAuthJson(text)
    } catch (error) {
      this.options.log("warn", `Ignoring ${file}: ${(error as Error).message}`)
    }
    return this.legacy
  }

  private readExport(): Promise<Map<string, string>> {
    if (this.exported) return this.exported
    // After a failure, give up for a while instead of re-running a slow
    // command for every provider or request in the meantime.
    if (Date.now() - this.failedAt < EXPORT_RETRY_MS) return Promise.resolve(new Map())
    this.exported = (async () => {
      const started = Date.now()
      this.onExport?.()
      try {
        const keys = parseAuthExport(await (this.options.runExport ?? runOpenCodeExport)())
        this.failedAt = -Infinity
        this.options.log(
          "info",
          `opencode auth export: API keys for ${[...keys.keys()].join(", ") || "no providers"} (${Date.now() - started}ms)`,
        )
        return keys
      } catch (error) {
        this.options.log("warn", `opencode auth export failed: ${(error as Error).message}`)
        this.failedAt = Date.now()
        this.exported = undefined
        return new Map<string, string>()
      }
    })()
    return this.exported
  }
}

async function runOpenCodeExport(): Promise<string> {
  const bin = findExecutable("opencode", process.env.OPENCODE_BIN)
  if (!bin) throw new Error("the opencode CLI is not on PATH (set OPENCODE_BIN to its path)")
  // Run outside the project so OpenCode does not set up a location for it.
  return captureOutput(bin, ["auth", "export"], { cwd: homedir(), timeoutMs: 120_000 })
}

/**
 * `opencode auth export` (OpenCode 2) prints every stored credential:
 * `[{ integrationID, active, value: { type: "key", key } | { type: "oauth", ... } }]`.
 * Only active API keys are usable here; OAuth logins belong to OpenCode.
 */
export function parseAuthExport(text: string): Map<string, string> {
  const start = text.indexOf("[")
  const end = text.lastIndexOf("]")
  if (start === -1 || end < start) {
    // Say what came back without risking a secret in the log.
    const preview = text.trim().slice(0, 120).replace(/[A-Za-z0-9_\-.]{16,}/g, "<redacted>")
    throw new Error(`unexpected output (no JSON array; ${text.length} bytes${preview ? `: ${JSON.stringify(preview)}` : ""})`)
  }
  const list = JSON.parse(text.slice(start, end + 1)) as unknown
  if (!Array.isArray(list)) throw new Error("unexpected output (not an array)")

  const keys = new Map<string, string>()
  for (const entry of list) {
    if (!isObject(entry) || typeof entry.integrationID !== "string") continue
    if (entry.active === false) continue
    const value = entry.value
    if (isObject(value) && value.type === "key" && typeof value.key === "string" && value.key) {
      keys.set(entry.integrationID, value.key)
    }
  }
  return keys
}

/** OpenCode 1.x: `{ "<provider>": { "type": "api", "key": "..." } }`. */
export function parseAuthJson(text: string): Map<string, string> {
  const data = JSON.parse(text) as unknown
  if (!isObject(data)) throw new Error("expected a JSON object")
  const keys = new Map<string, string>()
  for (const [id, entry] of Object.entries(data)) {
    if (!isObject(entry)) continue
    if (entry.type === "api" && typeof entry.key === "string") keys.set(id, entry.key)
    else if (entry.type === "wellknown" && typeof entry.token === "string") keys.set(id, entry.token)
  }
  return keys
}
