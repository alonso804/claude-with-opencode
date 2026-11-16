#!/usr/bin/env node
import { randomBytes } from "node:crypto"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { UsageError, parseArgs } from "./args.js"
import {
  RouteError,
  buildProviders,
  findModel,
  loadCatalog,
  resolveRoute,
  usableModels,
  type Provider,
  type Providers,
  type Route,
} from "./catalog.js"
import { Credentials } from "./credentials.js"
import { createConsoleLogger, createFileLogger, type LogFn } from "./logger.js"
import { loadOpenCodeConfig } from "./opencode-config.js"
import { appCacheDir } from "./paths.js"
import {
  PROTOCOL_LABEL,
  contextWindow,
  formatTokens,
  modelPickerSettings,
  providerOrder,
  slotLabels,
} from "./picker.js"
import { claudeEnvironment, findExecutable, runInteractive, type ClaudeEnvOptions } from "./process.js"
import { guardClaudeModel, readLastModel, writeLastModel } from "./claude-settings.js"
import { ANTHROPIC_URL, opencodeRef, startProxy } from "./proxy.js"
import { loadSettings, resolveDefaults, settingsFile } from "./settings.js"
import { VERSION } from "./version.js"

const help = () => `claude-with-opencode ${VERSION}
Claude Code with your Claude models plus the models you connected in OpenCode.

Usage:
  claude-with-opencode [--oc-* options] [claude options and arguments]

Everything that does not start with --oc- is passed to claude unchanged, e.g.
  claude-with-opencode --oc-model opencode-go/glm-5.3 -p "explain this repo"

Claude Code keeps its own Claude models and login. OpenCode models are added to
/model and can be picked by name (/model opencode-go/glm-5.3).

Options:
  --oc-model <provider/model>         Start the session on this OpenCode model
  --oc-small-model <provider/model>   Model for background work (the haiku slot)
  --oc-opus-model <provider/model>    Model behind /model opus
  --oc-sonnet-model <provider/model>  Model behind /model sonnet
  --oc-only                           OpenCode models only: every slot, no Claude
  --oc-effort <level>                 Reasoning effort for models that accept one
  --oc-port <port>                    Proxy port (default: any free port)
  --oc-models                         List the models of your connected providers
  --oc-serve                          Run only the proxy and print claude's environment
  --oc-version                        Print the version
  --oc-help                           Show this help

Defaults, first match wins: these options, claude's own --model, CWO_* variables,
${settingsFile()}, then (with --oc-only)
"model" / "small_model" in your OpenCode config.
`

async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv)
  if (options.help) {
    process.stdout.write(help())
    return 0
  }
  if (options.version) {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }

  const say = createConsoleLogger()
  const logFile = join(appCacheDir(), "proxy.log")
  // While Claude Code runs it owns the terminal, so the proxy logs to a file.
  const log = options.serve ? say : createFileLogger(logFile)

  const opencode = loadOpenCodeConfig(process.cwd(), log)
  const settings = loadSettings(log)
  const providers = buildProviders(await loadCatalog(log), opencode.providers)
  const credentials = new Credentials({ providers, log })
  const defaults = resolveDefaults({ cli: options, env: process.env, settings, opencode })

  if (options.listModels) return listModels(providers, credentials, say)
  if (defaults.opencodeOnly && !defaults.model) return explainMissingModel(providers, credentials, say)

  // Alongside Claude, /model lists the providers you connected in OpenCode.
  const connected = defaults.opencodeOnly ? [] : await connectedProviderIDs(providers, credentials, say)
  for (const id of connected) credentials.prefetch(id)
  const order = providerOrder(defaults, connected)

  // Anything plain `claude` cannot serve: provider/model, or a bare name
  // some OpenCode provider has (/model glm-5.3-flash).
  const otherProviders = Object.keys(providers).filter((id) => id !== "anthropic")
  const toOpenCodeRef = (model: string, lookIn: string[]) => {
    const ref = opencodeRef(model)
    if (ref) return ref.slice(0, ref.indexOf("/")) in providers ? ref : undefined
    return findModel(providers, model, lookIn)
  }
  // A /model choice of an OpenCode model must not stick to plain `claude`.
  const guard = options.serve ? undefined : guardClaudeModel((model) => !!toOpenCodeRef(model, otherProviders), log)
  if (guard?.leftover) writeLastModel(guard.leftover)
  if (!defaults.opencodeOnly && !defaults.model) {
    // Like Claude Code itself, start where the last /model choice left off.
    const last = readLastModel()
    const ref = last && toOpenCodeRef(last, [...order, ...otherProviders])
    if (ref) defaults.model = ref
  }

  let session: Route | undefined
  try {
    session = defaults.model ? resolveRoute(providers, defaults.model) : undefined
    for (const ref of [defaults.model, defaults.small, defaults.opus, defaults.sonnet]) {
      // Credentials are looked up while Claude Code starts, not after the
      // first prompt (`opencode auth export` can take a few seconds).
      if (ref) credentials.prefetch(resolveRoute(providers, ref).providerID)
    }
  } catch (error) {
    if (!(error instanceof RouteError)) throw error
    say("error", error.message)
    return 1
  }

  const token = randomBytes(24).toString("hex")
  const proxy = await startProxy({
    token,
    providers,
    credentials,
    defaults,
    log,
    port: options.port ?? portFromEnv() ?? settings.port,
    // A gateway the user already routes Claude through stays in the path.
    anthropicURL: process.env.CWO_ANTHROPIC_URL || process.env.ANTHROPIC_BASE_URL || ANTHROPIC_URL,
    // The session model's provider and the slots' come first now.
    lookupOrder: providerOrder(defaults, connected),
  })
  log("info", `proxy on ${proxy.url}, session model ${defaults.model ?? "(Claude Code's default)"}`)

  const envOptions: ClaudeEnvOptions = {
    baseURL: proxy.baseURL,
    token,
    defaults,
    labels: slotLabels(providers, defaults),
    contextWindow: session && contextWindow(session.model),
  }

  let pickerFile: string | undefined
  try {
    if (options.serve) return await serve(proxy.url, envOptions)

    const claude = findExecutable("claude", process.env.CLAUDE_PATH)
    if (!claude) {
      say(
        "error",
        "Claude Code CLI not found. Install it (npm install -g @anthropic-ai/claude-code) or set CLAUDE_PATH.",
      )
      return 1
    }

    const args = [...options.claudeArgs]
    // `/model` should offer OpenCode models. A --settings of the user's own wins.
    const picker = modelPickerSettings(providers, defaults, connected, settings.pickerModels)
    if (picker && !args.some((arg) => arg === "--settings" || arg.startsWith("--settings="))) {
      pickerFile = join(appCacheDir(), `claude-settings-${process.pid}.json`)
      mkdirSync(appCacheDir(), { recursive: true })
      writeFileSync(pickerFile, JSON.stringify(picker, null, 2))
      args.unshift("--settings", pickerFile)
    }

    const what = defaults.opencodeOnly
      ? defaults.model
      : `Claude + OpenCode${defaults.model ? `, starting on ${defaults.model}` : ""}`
    say("info", `${what} via ${proxy.url} (log: ${logFile})`)
    return await runInteractive(claude, args, claudeEnvironment(process.env, envOptions))
  } finally {
    if (pickerFile) rmSync(pickerFile, { force: true })
    await proxy.close()
    const notice = guard?.restore()
    if (notice) say("info", notice)
  }
}

function portFromEnv(): number | undefined {
  const value = Number(process.env.CWO_PORT)
  return process.env.CWO_PORT && Number.isInteger(value) ? value : undefined
}

async function serve(url: string, envOptions: ClaudeEnvOptions): Promise<number> {
  const entries = Object.entries(claudeEnvironment({}, envOptions)).filter(
    (entry): entry is [string, string] => !!entry[1],
  )
  process.stdout.write(
    [
      `Proxy running on ${url}. Start Claude Code with this environment:`,
      "",
      "  # bash / zsh",
      ...entries.map(([key, value]) => `  export ${key}='${value}'`),
      "",
      "  # PowerShell",
      ...entries.map(([key, value]) => `  $env:${key} = '${value}'`),
      "",
      "Press Ctrl+C to stop.",
      "",
    ].join("\n"),
  )
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve)
    process.once("SIGTERM", resolve)
  })
  return 0
}

async function connectedProviders(providers: Providers, credentials: Credentials): Promise<Provider[]> {
  const connected: Provider[] = []
  for (const provider of Object.values(providers)) {
    if (await credentials.find(provider.id)) connected.push(provider)
  }
  return connected
}

// Provider ids only, never keys: lets /model list OpenCode models at once,
// while the fresh list is worked out in the background for the next start.
const connectedCache = () => join(appCacheDir(), "connected-providers.json")

async function connectedProviderIDs(providers: Providers, credentials: Credentials, say: LogFn): Promise<string[]> {
  let cached: string[] | undefined
  try {
    const data = JSON.parse(readFileSync(connectedCache(), "utf8")) as unknown
    if (Array.isArray(data)) cached = data.filter((id): id is string => typeof id === "string" && id in providers)
  } catch {
    // first run
  }

  const fresh = connectedProviders(providers, credentials).then((list) => {
    const ids = list.map((provider) => provider.id)
    // A failed export says nothing about what is connected.
    if (!credentials.exportFailed) {
      try {
        mkdirSync(appCacheDir(), { recursive: true })
        writeFileSync(connectedCache(), JSON.stringify(ids))
      } catch {
        // only a cache
      }
    }
    return ids
  })

  if (cached) {
    fresh.catch(() => {})
    return cached
  }
  credentials.onExport = () => say("info", "reading your OpenCode credentials (opencode auth export)...")
  return fresh
}

async function listModels(providers: Providers, credentials: Credentials, say: LogFn): Promise<number> {
  credentials.onExport = () => say("info", "reading your OpenCode credentials (opencode auth export)...")
  const connected = await connectedProviders(providers, credentials)
  if (!connected.length) {
    say("error", "No connected providers found. Connect one in OpenCode (opencode auth login) or set its API key variable.")
    return 1
  }
  const lines: string[] = []
  for (const provider of connected) {
    lines.push("", `${provider.name ?? provider.id} (${provider.id})`)
    if (provider.baseURL) lines.push(`  base URL from your OpenCode config: ${provider.baseURL}`)
    for (const [key, model] of usableModels(provider)) {
      const route = resolveRoute(providers, `${provider.id}/${key}`)
      const window = contextWindow(model)
      lines.push(
        `  ${route.ref.padEnd(44)} ${(model.name ?? "").padEnd(30)} ${(window ? `${formatTokens(window)} ctx` : "").padEnd(9)} ${PROTOCOL_LABEL[route.protocol]}`,
      )
    }
  }
  process.stdout.write(`${lines.join("\n")}\n`)
  return 0
}

async function explainMissingModel(providers: Providers, credentials: Credentials, say: LogFn): Promise<number> {
  credentials.onExport = () => say("info", "reading your OpenCode credentials (opencode auth export)...")
  const connected = await connectedProviders(providers, credentials)
  // Suggest OpenCode's own providers first, and never one rerouted by config.
  const rank = (provider: Provider) => (provider.baseURL ? 2 : provider.id.startsWith("opencode") ? 0 : 1)
  const example =
    connected
      .sort((a, b) => rank(a) - rank(b))
      .map((provider) => {
        const first = usableModels(provider)[0]
        return first && `${provider.id}/${first[0]}`
      })
      .find(Boolean) ?? "<provider>/<model>"
  process.stderr.write(
    [
      "--oc-only needs a model. Pick one of your OpenCode models, for example:",
      "",
      `  claude-with-opencode --oc-only --oc-model ${example}`,
      "",
      `or make it the default in ${settingsFile()}:`,
      "",
      `  { "model": "${example}" }`,
      "",
      "claude-with-opencode --oc-models lists every model you can use.",
      "",
    ].join("\n"),
  )
  return 1
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`claude-with-opencode: ${message}\n`)
    process.exit(error instanceof UsageError ? 2 : 1)
  },
)
