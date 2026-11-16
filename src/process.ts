import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process"
import { accessSync, constants, statSync } from "node:fs"
import { constants as osConstants } from "node:os"
import { delimiter, join } from "node:path"

import type { ModelDefaults } from "./settings.js"

const IS_WINDOWS = process.platform === "win32"

// ---------------------------------------------------------------------------
// Locating executables
// ---------------------------------------------------------------------------

export function findExecutable(name: string, override?: string): string | undefined {
  if (override) return isExecutable(override) ? override : undefined
  const dirs = (process.env.PATH ?? "")
    .split(delimiter)
    .map((dir) => dir.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean)
  const extensions = IS_WINDOWS ? windowsExtensions() : [""]
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = join(dir, name + extension)
      if (isExecutable(candidate)) return candidate
    }
  }
  return undefined
}

function windowsExtensions(): string[] {
  const listed = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.trim().toLowerCase())
    .filter(Boolean)
  // A native claude.exe wins over an npm .cmd shim in the same directory.
  return [".exe", ...listed.filter((extension) => extension !== ".exe")]
}

function isExecutable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false
    if (!IS_WINDOWS) accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Spawning (Windows batch shims need cmd.exe)
// ---------------------------------------------------------------------------

const CMD_META = /([()\][%!^"`<>&|;, *?])/g

function isBatchFile(file: string): boolean {
  return IS_WINDOWS && /\.(cmd|bat)$/i.test(file)
}

export function spawnCommand(file: string, args: string[], options: SpawnOptions): ChildProcess {
  if (isBatchFile(file)) {
    // Node refuses to run batch files without a shell, so go through cmd.exe
    // with the quoting npm's .cmd shims expect (the scheme cross-spawn uses).
    const command = [file.replace(CMD_META, "^$1"), ...args.map(quoteForCmdShim)].join(" ")
    return spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${command}"`], {
      ...options,
      windowsVerbatimArguments: true,
    })
  }
  return spawn(file, args, options)
}

function quoteForCmdShim(arg: string): string {
  const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`
  // Once for this cmd.exe, once more for the shim's own expansion.
  return quoted.replace(CMD_META, "^$1").replace(CMD_META, "^$1")
}

/** Runs a command to completion and returns its stdout. */
export function captureOutput(
  file: string,
  args: string[],
  options: { cwd?: string; timeoutMs: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnCommand(file, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      // Its own process group, so a Ctrl+C meant for Claude Code does not
      // kill it. Not for batch shims: a detached cmd.exe has no console, so
      // the program it starts opens a new one and its output never reaches
      // our pipe (npm installs `opencode.cmd` like that).
      detached: !isBatchFile(file),
    })
    const stdout: Buffer[] = []
    let stderr = ""
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk))
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-4000)
    })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`timed out after ${Math.round(options.timeoutMs / 1000)}s`))
    }, options.timeoutMs)
    child.once("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once("close", (code) => {
      clearTimeout(timer)
      // Last stderr line, with anything that could be a key masked.
      const detail = stderr
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .at(-1)
        ?.replace(/[A-Za-z0-9_\-.]{32,}/g, "<redacted>")
      if (code !== 0) return reject(new Error(`exited with code ${code}${detail ? `: ${detail}` : ""}`))
      const output = Buffer.concat(stdout).toString("utf8")
      // An empty success is a failure too; stderr is the only clue then.
      if (!output.trim() && detail) return reject(new Error(`no output: ${detail.slice(0, 300)}`))
      resolve(output)
    })
  })
}

// ---------------------------------------------------------------------------
// Running Claude Code
// ---------------------------------------------------------------------------

// Cloud-provider switches make Claude Code ignore ANTHROPIC_BASE_URL.
const ALWAYS_REMOVED = ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"]
// With --oc-only nothing goes to Anthropic, so its credentials stay out.
const REMOVED_WITHOUT_CLAUDE = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_SMALL_FAST_MODEL"]

export interface ClaudeEnvOptions {
  /** The proxy's ANTHROPIC_BASE_URL, token prefix included. */
  baseURL: string
  token: string
  defaults: ModelDefaults
  /** Picker labels per slot, e.g. "GLM-5.3 (OpenCode Go)". */
  labels?: Partial<Record<"model" | "small" | "opus" | "sonnet", string>>
  /** The session model's real context window, when it is an OpenCode model. */
  contextWindow?: number
}

export function claudeEnvironment(base: NodeJS.ProcessEnv, options: ClaudeEnvOptions): NodeJS.ProcessEnv {
  const { opencodeOnly } = options.defaults
  const removed = opencodeOnly ? [...ALWAYS_REMOVED, ...REMOVED_WITHOUT_CLAUDE] : ALWAYS_REMOVED
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(base)) {
    // Our own variables replace any the user had (Windows keys are case-insensitive).
    if (!removed.includes(key.toUpperCase()) && key.toUpperCase() !== "ANTHROPIC_BASE_URL") env[key] = value
  }
  const has = (name: string) => Object.keys(env).some((key) => key.toUpperCase() === name)
  const setDefault = (name: string, value: string | undefined) => {
    if (value && !has(name)) env[name] = value
  }

  // The token rides in the base URL path, so it reaches the proxy whatever
  // credential Claude Code sends: its own Claude login when Claude stays
  // available, or this token as the only credential with --oc-only.
  env.ANTHROPIC_BASE_URL = options.baseURL
  if (opencodeOnly) env.ANTHROPIC_AUTH_TOKEN = options.token

  const { model, small, opus, sonnet } = options.defaults
  const labels = options.labels ?? {}
  if (model) env.ANTHROPIC_MODEL = model
  // Alongside Claude, a slot changes only when you pick a model for it;
  // with --oc-only every slot needs an OpenCode model, the main one by default.
  const slots: Array<[string, string | undefined, string | undefined]> = opencodeOnly
    ? [
        ["OPUS", opus ?? model, opus ? labels.opus : labels.model],
        ["SONNET", sonnet ?? model, sonnet ? labels.sonnet : labels.model],
        ["HAIKU", small ?? model, small ? labels.small : labels.model],
      ]
    : [
        ["OPUS", opus, labels.opus],
        ["SONNET", sonnet, labels.sonnet],
        ["HAIKU", small, labels.small],
      ]
  for (const [slot, ref, label] of slots) {
    if (!ref) continue
    env[`ANTHROPIC_DEFAULT_${slot}_MODEL`] = ref
    setDefault(`ANTHROPIC_DEFAULT_${slot}_MODEL_NAME`, label)
  }

  // Claude Code assumes 200k for model ids it does not know and compacts
  // there; the catalog knows the real window. Claude models are unaffected.
  setDefault("CLAUDE_CODE_MAX_CONTEXT_TOKENS", options.contextWindow ? String(options.contextWindow) : undefined)
  return env
}

/** Runs `file` attached to this terminal and resolves with its exit code. */
export function runInteractive(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawnCommand(file, args, { stdio: "inherit", env })

    // Claude Code handles Ctrl+C itself (cancel a turn, press twice to quit),
    // but the terminal delivers it to this process too. Ignoring it here keeps
    // the proxy alive until Claude Code actually exits.
    const ignore = () => {}
    const onTerm = () => child.kill("SIGTERM")
    const onHup = () => child.kill("SIGHUP")
    process.on("SIGINT", ignore)
    process.on("SIGTERM", onTerm)
    process.on("SIGHUP", onHup)
    const cleanup = () => {
      process.off("SIGINT", ignore)
      process.off("SIGTERM", onTerm)
      process.off("SIGHUP", onHup)
    }

    child.once("error", (error) => {
      cleanup()
      reject(error)
    })
    child.once("exit", (code, signal) => {
      cleanup()
      if (code !== null) return resolve(code)
      resolve(signal ? 128 + (osConstants.signals[signal] ?? 0) : 1)
    })
  })
}
