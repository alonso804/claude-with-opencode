import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"

import type { CatalogModel } from "./catalog.js"
import { deepMerge, isObject, parseJsonc, type JsonObject } from "./json.js"
import type { LogFn } from "./logger.js"
import { opencodeConfigDir } from "./paths.js"

/** What OpenCode's config can say about a provider, in either generation's keys. */
export interface ProviderOverride {
  name?: string
  npm?: string
  /** Base URL that replaces the catalog's for every model of the provider. */
  baseURL?: string
  apiKey?: string
  headers?: Record<string, string>
  env?: string[]
  models: Record<string, Partial<CatalogModel>>
}

export interface OpenCodeConfig {
  model?: string
  smallModel?: string
  providers: Record<string, ProviderOverride>
  /** Files that were read, lowest precedence first. */
  files: string[]
}

const GLOBAL_FILES = ["config.json", "opencode.json", "opencode.jsonc"]
const PROJECT_FILES = [
  "opencode.json",
  "opencode.jsonc",
  join(".opencode", "opencode.json"),
  join(".opencode", "opencode.jsonc"),
]

/** Config files in OpenCode's precedence order, lowest first. */
export function opencodeConfigFiles(cwd: string): string[] {
  const files = GLOBAL_FILES.map((name) => join(opencodeConfigDir(), name))
  if (process.env.OPENCODE_CONFIG) files.push(resolve(process.env.OPENCODE_CONFIG))
  for (const dir of projectDirs(cwd)) {
    for (const name of PROJECT_FILES) files.push(join(dir, name))
  }
  return [...new Set(files)]
}

/** From the project root (nearest git root) down to `cwd`. */
function projectDirs(cwd: string): string[] {
  const dirs: string[] = []
  const home = resolve(homedir())
  let dir = resolve(cwd)
  // The home directory is covered by the global config.
  while (dir !== home) {
    dirs.unshift(dir)
    if (existsSync(join(dir, ".git"))) break
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return dirs
}

export function loadOpenCodeConfig(cwd: string, log: LogFn): OpenCodeConfig {
  let merged: JsonObject = {}
  const files: string[] = []

  for (const file of opencodeConfigFiles(cwd)) {
    let text: string
    try {
      text = readFileSync(file, "utf8")
    } catch {
      continue
    }
    try {
      const data = parseJsonc(substitute(text, dirname(file)))
      if (!isObject(data)) throw new Error("expected a JSON object")
      merged = deepMerge(merged, data)
      files.push(file)
    } catch (error) {
      log("warn", `Ignoring OpenCode config ${file}: ${(error as Error).message}`)
    }
  }

  const inline = process.env.OPENCODE_CONFIG_CONTENT
  if (inline) {
    try {
      const data = parseJsonc(substitute(inline, process.cwd()))
      if (isObject(data)) merged = deepMerge(merged, data)
    } catch (error) {
      log("warn", `Ignoring OPENCODE_CONFIG_CONTENT: ${(error as Error).message}`)
    }
  }

  return { ...extract(merged), files }
}

/** OpenCode's `{env:NAME}` and `{file:path}` placeholders. */
export function substitute(text: string, baseDir: string): string {
  return text
    .replace(/\{env:([^}]+)\}/g, (_, name: string) => process.env[name.trim()] ?? "")
    .replace(/\{file:([^}]+)\}/g, (_, raw: string) => {
      let path = raw.trim()
      if (path.startsWith("~/")) path = join(homedir(), path.slice(2))
      try {
        const content = readFileSync(isAbsolute(path) ? path : resolve(baseDir, path), "utf8")
        return JSON.stringify(content.trim()).slice(1, -1)
      } catch {
        return ""
      }
    })
}

function extract(config: JsonObject): Omit<OpenCodeConfig, "files"> {
  // OpenCode 1.x uses `provider.<id>.options`; OpenCode 2 uses
  // `providers.<id>.settings`. Accept both so one file works either way.
  const raw = deepMerge(asObject(config.provider), asObject(config.providers))
  const providers: Record<string, ProviderOverride> = {}

  for (const [id, value] of Object.entries(raw)) {
    if (!isObject(value)) continue
    const settings = { ...asObject(value.options), ...asObject(value.settings) }
    providers[id] = {
      name: str(value.name),
      npm: str(value.npm) ?? str(value.package),
      baseURL: str(settings.baseURL) ?? str(value.api),
      apiKey: str(settings.apiKey),
      headers: strings({ ...asObject(settings.headers), ...asObject(value.headers) }),
      env: Array.isArray(value.env)
        ? value.env.filter((item): item is string => typeof item === "string")
        : undefined,
      models: models(value.models),
    }
  }

  return {
    model: str(config.model),
    smallModel: str(config.small_model),
    providers,
  }
}

const MODEL_KEYS = [
  "id",
  "name",
  "family",
  "tool_call",
  "reasoning",
  "reasoning_options",
  "temperature",
  "attachment",
  "interleaved",
  "limit",
  "modalities",
  "release_date",
  "status",
  "cost",
  "provider",
] as const

function models(value: unknown): Record<string, Partial<CatalogModel>> {
  const out: Record<string, Partial<CatalogModel>> = {}
  for (const [id, model] of Object.entries(asObject(value))) {
    if (!isObject(model)) continue
    const entry: JsonObject = {}
    for (const key of MODEL_KEYS) if (model[key] !== undefined) entry[key] = model[key]
    out[id] = entry as Partial<CatalogModel>
  }
  return out
}

function asObject(value: unknown): JsonObject {
  return isObject(value) ? value : {}
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function strings(value: JsonObject): Record<string, string> | undefined {
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  )
  return entries.length ? Object.fromEntries(entries) : undefined
}
