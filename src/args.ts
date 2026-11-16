export interface CliOptions {
  model?: string
  smallModel?: string
  opusModel?: string
  sonnetModel?: string
  effort?: string
  port?: number
  serve: boolean
  listModels: boolean
  help: boolean
  version: boolean
  opencodeOnly: boolean
  /** Everything that is not ours, in order, for `claude`. */
  claudeArgs: string[]
}

export class UsageError extends Error {}

type ValueKey = "model" | "smallModel" | "opusModel" | "sonnetModel" | "effort" | "port"
type FlagKey = "serve" | "listModels" | "help" | "version" | "opencodeOnly"

const VALUE_FLAGS: Record<string, ValueKey> = {
  "--oc-model": "model",
  "--oc-small-model": "smallModel",
  "--oc-opus-model": "opusModel",
  "--oc-sonnet-model": "sonnetModel",
  "--oc-effort": "effort",
  "--oc-port": "port",
}

const BOOLEAN_FLAGS: Record<string, FlagKey> = {
  "--oc-serve": "serve",
  "--oc-models": "listModels",
  "--oc-help": "help",
  "--oc-version": "version",
  "--oc-only": "opencodeOnly",
}

/**
 * Our options all start with `--oc-`, so they can sit anywhere on the command
 * line without colliding with claude's own flags, which pass through as-is.
 */
export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    serve: false,
    listModels: false,
    help: false,
    version: false,
    opencodeOnly: false,
    claudeArgs: [],
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith("--oc-")) {
      options.claudeArgs.push(arg)
      continue
    }

    const eq = arg.indexOf("=")
    const flag = eq === -1 ? arg : arg.slice(0, eq)

    const toggle = BOOLEAN_FLAGS[flag]
    if (toggle) {
      if (eq !== -1) throw new UsageError(`${flag} does not take a value`)
      options[toggle] = true
      continue
    }

    const key = VALUE_FLAGS[flag]
    if (!key) {
      throw new UsageError(
        `Unknown option ${flag}. claude-with-opencode's own options start with --oc- (see --oc-help); everything else goes to claude.`,
      )
    }
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1)
    if (!value) throw new UsageError(`${flag} needs a value`)
    if (key === "port") {
      const port = Number(value)
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new UsageError(`${flag} must be a port number, got "${value}"`)
      }
      options.port = port
    } else {
      options[key] = value
    }
  }

  return options
}

/** The value of claude's own `--model` flag, if one was passed through. */
export function claudeModelArg(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--model") return args[i + 1]
    if (args[i].startsWith("--model=")) return args[i].slice("--model=".length)
  }
  return undefined
}
