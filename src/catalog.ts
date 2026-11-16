import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { isObject } from "./json.js"
import type { LogFn } from "./logger.js"
import type { ProviderOverride } from "./opencode-config.js"
import { appCacheDir, opencodeCacheDir } from "./paths.js"

// ---------------------------------------------------------------------------
// models.dev catalog: the same source OpenCode builds its model list from
// ---------------------------------------------------------------------------

export interface CatalogModel {
  /** Model id sent upstream. Usually equal to the catalog key. */
  id: string
  name?: string
  family?: string
  tool_call?: boolean
  reasoning?: boolean
  reasoning_options?: Array<{ type: string; values?: string[] }>
  temperature?: boolean
  attachment?: boolean
  /** Where the model expects earlier reasoning to be sent back. */
  interleaved?: boolean | { field?: string }
  limit?: { context?: number; input?: number; output?: number }
  modalities?: { input?: string[]; output?: string[] }
  release_date?: string
  status?: string
  cost?: { input?: number; output?: number }
  /** Per-model transport override (OpenCode Zen and Go mix several). */
  provider?: { npm?: string; api?: string; shape?: string }
}

export interface CatalogProvider {
  id: string
  name?: string
  npm?: string
  api?: string
  env?: string[]
  models: Record<string, CatalogModel>
}

export type Catalog = Record<string, CatalogProvider>

/** A catalog provider with the user's OpenCode config layered on top. */
export interface Provider extends CatalogProvider {
  baseURL?: string
  apiKey?: string
  headers?: Record<string, string>
}

export type Providers = Record<string, Provider>

const CATALOG_URL = "https://models.dev/api.json"
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

export async function loadCatalog(log: LogFn): Promise<Catalog> {
  const explicit = process.env.CWO_MODELS_PATH
  if (explicit) return parseCatalog(readFileSync(explicit, "utf8"))

  const cache = join(appCacheDir(), "models.json")
  const cached = readCatalog(cache, log)
  if (cached) {
    // A day-old catalog is still right for every model already in it, so a
    // refresh never blocks startup once there is a copy on disk.
    if (ageOf(cache) > CACHE_TTL_MS) void refreshCatalog(cache, log).catch(() => {})
    return cached
  }

  try {
    return await refreshCatalog(cache, log)
  } catch (error) {
    log("warn", `Could not download the model catalog: ${(error as Error).message}`)
  }

  const fromOpenCode = readCatalog(join(opencodeCacheDir(), "models.json"), log)
  if (fromOpenCode) return fromOpenCode
  log("warn", "No model catalog available; only providers from your OpenCode config can be used.")
  return {}
}

async function refreshCatalog(cache: string, log: LogFn): Promise<Catalog> {
  const res = await fetch(process.env.CWO_MODELS_URL || CATALOG_URL, {
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const text = await res.text()
  const catalog = parseCatalog(text)
  try {
    mkdirSync(appCacheDir(), { recursive: true })
    writeFileSync(cache, text)
  } catch (error) {
    log("warn", `Could not cache the model catalog: ${(error as Error).message}`)
  }
  return catalog
}

function readCatalog(file: string, log: LogFn): Catalog | undefined {
  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch {
    return undefined
  }
  try {
    return parseCatalog(text)
  } catch (error) {
    log("warn", `Ignoring model catalog ${file}: ${(error as Error).message}`)
    return undefined
  }
}

function ageOf(file: string): number {
  try {
    return Date.now() - statSync(file).mtimeMs
  } catch {
    return Infinity
  }
}

export function parseCatalog(text: string): Catalog {
  const data = JSON.parse(text) as unknown
  if (!isObject(data)) throw new Error("expected a JSON object")
  const catalog: Catalog = {}
  for (const [id, value] of Object.entries(data)) {
    if (!isObject(value)) continue
    const provider = value as unknown as CatalogProvider
    const models: Record<string, CatalogModel> = {}
    for (const [key, model] of Object.entries(isObject(provider.models) ? provider.models : {})) {
      if (isObject(model)) models[key] = { ...(model as unknown as CatalogModel), id: typeof model.id === "string" ? model.id : key }
    }
    catalog[id] = { ...provider, id, models }
  }
  return catalog
}

export function buildProviders(
  catalog: Catalog,
  overrides: Record<string, ProviderOverride>,
): Providers {
  const providers: Providers = {}
  for (const [id, provider] of Object.entries(catalog)) providers[id] = provider

  for (const [id, override] of Object.entries(overrides)) {
    const base: Provider = providers[id] ?? { id, models: {} }
    const merged: Provider = { ...base, models: { ...base.models } }
    if (override.name) merged.name = override.name
    if (override.npm) merged.npm = override.npm
    if (override.baseURL) merged.baseURL = override.baseURL
    if (override.apiKey) merged.apiKey = override.apiKey
    if (override.env?.length) merged.env = override.env
    if (override.headers) merged.headers = { ...base.headers, ...override.headers }
    for (const [key, model] of Object.entries(override.models)) {
      const existing = merged.models[key]
      merged.models[key] = { ...existing, ...model, id: model.id ?? existing?.id ?? key }
    }
    providers[id] = merged
  }
  return providers
}

// ---------------------------------------------------------------------------
// Routing: which wire protocol and URL a `provider/model` reference uses
// ---------------------------------------------------------------------------

export type Protocol = "anthropic" | "openai-chat" | "openai-responses"

export interface Route {
  /** `provider/model` as resolved. */
  ref: string
  providerID: string
  modelID: string
  upstreamModel: string
  protocol: Protocol
  /** Includes the version segment, e.g. `https://opencode.ai/inference/openai/v1`. */
  baseURL: string
  headers: Record<string, string>
  model: CatalogModel
  provider: Provider
}

export class RouteError extends Error {
  constructor(
    message: string,
    readonly status = 404,
  ) {
    super(message)
  }
}

// AI SDK packages whose transport is not one of the three protocols this
// proxy speaks (or that need cloud credentials, not an API key).
const UNSUPPORTED = new Set([
  "@ai-sdk/google",
  "@ai-sdk/google-vertex",
  "@ai-sdk/google-vertex/anthropic",
  "@ai-sdk/amazon-bedrock",
  "@ai-sdk/amazon-bedrock/mantle",
  "@ai-sdk/azure",
  "@ai-sdk/gateway",
  "@ai-sdk/cohere",
  "ai-gateway-provider",
  "gitlab-ai-provider",
  "watsonx-ai-provider",
])

// Base URLs the AI SDK packages use when the catalog does not give one.
const DEFAULT_BASE_URL: Record<string, string> = {
  "@ai-sdk/anthropic": "https://api.anthropic.com/v1",
  "@ai-sdk/openai": "https://api.openai.com/v1",
  "@ai-sdk/groq": "https://api.groq.com/openai/v1",
  "@ai-sdk/mistral": "https://api.mistral.ai/v1",
  "@ai-sdk/xai": "https://api.x.ai/v1",
  "@ai-sdk/deepseek": "https://api.deepseek.com/v1",
  "@ai-sdk/cerebras": "https://api.cerebras.ai/v1",
  "@ai-sdk/togetherai": "https://api.together.xyz/v1",
  "@ai-sdk/fireworks": "https://api.fireworks.ai/inference/v1",
  "@ai-sdk/deepinfra": "https://api.deepinfra.com/v1/openai",
  "@ai-sdk/perplexity": "https://api.perplexity.ai",
  "@openrouter/ai-sdk-provider": "https://openrouter.ai/api/v1",
}

export function protocolFor(npm: string | undefined, shape?: string): Protocol | undefined {
  if (npm && UNSUPPORTED.has(npm)) return undefined
  if (shape === "responses") return "openai-responses"
  if (shape === "completions") return "openai-chat"
  if (npm === "@ai-sdk/anthropic") return "anthropic"
  if (npm === "@ai-sdk/openai") return "openai-responses"
  // Everything else in the catalog is OpenAI-compatible Chat Completions.
  return "openai-chat"
}

export function resolveRoute(providers: Providers, ref: string): Route {
  const slash = ref.indexOf("/")
  if (slash <= 0 || slash === ref.length - 1) {
    throw new RouteError(
      `"${ref}" is not an OpenCode model. Use provider/model, for example opencode-go/glm-5.3.`,
      400,
    )
  }
  const providerID = ref.slice(0, slash)
  const modelID = ref.slice(slash + 1)

  const provider = providers[providerID]
  if (!provider) {
    throw new RouteError(`Unknown provider "${providerID}" in model "${ref}".`)
  }

  // Models missing from the catalog are still allowed: providers ship new
  // ones faster than models.dev lists them.
  const model =
    provider.models[modelID] ??
    Object.values(provider.models).find((candidate) => candidate.id === modelID) ??
    { id: modelID }

  const npm = model.provider?.npm ?? provider.npm
  const protocol = protocolFor(npm, model.provider?.shape)
  if (!protocol) {
    throw new RouteError(
      `${ref} needs ${npm}, which claude-with-opencode cannot translate yet. Supported: Anthropic Messages, OpenAI Chat Completions and OpenAI Responses models.`,
      400,
    )
  }

  const baseURL =
    provider.baseURL ?? model.provider?.api ?? provider.api ?? (npm ? DEFAULT_BASE_URL[npm] : undefined)
  if (!baseURL) {
    throw new RouteError(
      `No base URL known for provider "${providerID}". Set one in your OpenCode config.`,
      400,
    )
  }

  return {
    ref,
    providerID,
    modelID,
    upstreamModel: model.id,
    protocol,
    baseURL: baseURL.replace(/\/+$/, ""),
    headers: provider.headers ?? {},
    model,
    provider,
  }
}

/**
 * Resolves a model typed without its provider (`/model glm-5.3-flash`) to
 * the first provider in `order` that has it. Claude's own names never match.
 */
export function findModel(providers: Providers, requested: string, order: string[]): string | undefined {
  const name = requested.replace(/\[[^\]]*\]$/, "").trim()
  if (!name || name.includes("/") || /^claude-/i.test(name)) return undefined
  for (const id of order) {
    const provider = providers[id]
    if (!provider) continue
    const key = provider.models[name]
      ? name
      : Object.entries(provider.models).find(([, model]) => model.id === name)?.[0]
    if (!key) continue
    try {
      return resolveRoute(providers, `${id}/${key}`).ref
    } catch {
      // not routable through this provider; try the next one
    }
  }
  return undefined
}

/** Models worth offering to Claude Code: routable, tool-capable, not retired. */
export function usableModels(provider: Provider): Array<[string, CatalogModel]> {
  return Object.entries(provider.models)
    .filter(([key]) => {
      try {
        resolveRoute({ [provider.id]: provider }, `${provider.id}/${key}`)
        return true
      } catch {
        return false
      }
    })
    .filter(([, model]) => model.tool_call !== false && model.status !== "deprecated")
    .sort(([a, x], [b, y]) =>
      (y.release_date ?? "").localeCompare(x.release_date ?? "") || a.localeCompare(b),
    )
}
