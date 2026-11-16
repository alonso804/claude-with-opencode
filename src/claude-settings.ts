// Claude Code saves a `/model` choice as `model` in its user settings, the
// default for every later session. An OpenCode model left there would break
// plain `claude`, which has no proxy to reach it. So the wrapper hands the
// setting back the way it found it and remembers the OpenCode choice for its
// own next start instead.

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { isObject, type JsonObject } from "./json.js"
import type { LogFn } from "./logger.js"
import { appCacheDir } from "./paths.js"

export const claudeSettingsFile = () =>
  join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "settings.json")

const lastModelFile = () => join(appCacheDir(), "last-model.json")

function readJSONFile(file: string): JsonObject | undefined {
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as unknown
    return isObject(data) ? data : undefined
  } catch {
    return undefined
  }
}

function mtime(file: string): number | undefined {
  try {
    return statSync(file).mtimeMs
  } catch {
    return undefined
  }
}

/** The model Claude Code's user settings start sessions on. */
export function readClaudeModel(file = claudeSettingsFile()): string | undefined {
  const value = readJSONFile(file)?.model
  return typeof value === "string" ? value : undefined
}

/** Sets (or, with undefined, removes) only the `model` key, keeping everything else. */
export function writeClaudeModel(model: string | undefined, file = claudeSettingsFile()): boolean {
  const data = readJSONFile(file)
  if (!data) return false
  if (model === undefined) delete data.model
  else data.model = model
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`)
  return true
}

/** The OpenCode model picked with /model in the previous wrapper session. */
export function readLastModel(): string | undefined {
  const value = readJSONFile(lastModelFile())?.model
  return typeof value === "string" ? value : undefined
}

export function writeLastModel(model: string | undefined): void {
  try {
    mkdirSync(appCacheDir(), { recursive: true })
    writeFileSync(lastModelFile(), JSON.stringify(model ? { model } : {}))
  } catch {
    // only a convenience
  }
}

/**
 * Snapshot Claude Code's `model` setting before the session; call the
 * returned function after it to undo an OpenCode choice saved meanwhile.
 * Returns a notice for the user when something was restored.
 */
export function guardClaudeModel(
  isOpenCodeModel: (model: string) => boolean,
  log: LogFn,
  file = claudeSettingsFile(),
): { leftover?: string; restore: () => string | undefined } {
  let before = readClaudeModel(file)
  let leftover: string | undefined
  if (before && isOpenCodeModel(before)) {
    // Left by a session that could not clean up (or an older version):
    // plain `claude` cannot use it, so fall back to Claude Code's default.
    leftover = before
    before = undefined
    try {
      writeClaudeModel(undefined, file)
      log("info", `Removed OpenCode model "${leftover}" from ${file}`)
    } catch (error) {
      log("warn", `Could not update ${file}: ${(error as Error).message}`)
    }
  }

  const startedAt = mtime(file)
  return {
    leftover,
    restore: () => {
      const after = readClaudeModel(file)
      if (!after || !isOpenCodeModel(after)) {
        // A Claude model picked with /model (the file was written) is valid
        // for plain `claude` too: keep it, and start on it next time as well.
        if (mtime(file) !== startedAt) writeLastModel(undefined)
        return undefined
      }
      writeLastModel(after)
      try {
        writeClaudeModel(before, file)
      } catch (error) {
        log("warn", `Could not restore ${file}: ${(error as Error).message}`)
        return undefined
      }
      log("info", `Restored "model" in ${file} to ${before ?? "(unset)"}; remembered ${after}`)
      return `${after} stays the model for claude-with-opencode; plain claude keeps ${before ?? "its default model"}.`
    },
  }
}
