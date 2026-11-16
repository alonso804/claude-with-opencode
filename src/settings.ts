import { readFileSync } from "node:fs"
import { join } from "node:path"

import { claudeModelArg, type CliOptions } from "./args.js"
import { isObject, parseJsonc } from "./json.js"
import type { LogFn } from "./logger.js"
import type { OpenCodeConfig } from "./opencode-config.js"
import { appConfigDir } from "./paths.js"

/** `~/.config/claude-with-opencode/config.json` */
export interface Settings {
  model?: string
  smallModel?: string
  opusModel?: string
  sonnetModel?: string
  effort?: string
  port?: number
  opencodeOnly?: boolean
  /** What `/model` lists: `provider/model` entries or whole provider ids, in this order. */
  pickerModels?: string[]
}

/** Which models fill Claude Code's slots, and whether Claude stays available. */
export interface ModelDefaults {
  model?: string
  small?: string
  opus?: string
  sonnet?: string
  effort?: string
  /**
   * Off (the default): Claude Code keeps its own Claude models and login, and
   * OpenCode models are added next to them. On: every slot is an OpenCode
   * model and Claude is not used at all.
   */
  opencodeOnly: boolean
}

export const settingsFile = () => join(appConfigDir(), "config.json")

export function loadSettings(log: LogFn): Settings {
  const file = settingsFile()
  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch {
    return {}
  }
  try {
    const data = parseJsonc(text)
    if (!isObject(data)) throw new Error("expected a JSON object")
    const str = (key: string) =>
      typeof data[key] === "string" && data[key] ? (data[key] as string) : undefined
    return {
      model: str("model"),
      smallModel: str("smallModel"),
      opusModel: str("opusModel"),
      sonnetModel: str("sonnetModel"),
      effort: str("effort"),
      port: Number.isInteger(data.port) ? (data.port as number) : undefined,
      opencodeOnly: data.opencodeOnly === true ? true : undefined,
      pickerModels: Array.isArray(data.pickerModels)
        ? data.pickerModels.filter((entry): entry is string => typeof entry === "string" && !!entry.trim())
        : undefined,
    }
  } catch (error) {
    log("warn", `Ignoring ${file}: ${(error as Error).message}`)
    return {}
  }
}

/**
 * First match wins: wrapper flags, claude's own --model, CWO_* variables,
 * the settings file, then (only with --oc-only) OpenCode's `model` /
 * `small_model`. Alongside Claude, Claude Code's own default model stays the
 * fallback instead.
 */
export function resolveDefaults(sources: {
  cli: CliOptions
  env: NodeJS.ProcessEnv
  settings: Settings
  opencode: Pick<OpenCodeConfig, "model" | "smallModel">
}): ModelDefaults {
  const { cli, settings } = sources
  const env = (name: string) => sources.env[name]?.trim() || undefined
  const claudeModel = claudeModelArg(cli.claudeArgs)
  const opencodeOnly = cli.opencodeOnly || /^(1|true)$/i.test(env("CWO_OPENCODE_ONLY") ?? "") || !!settings.opencodeOnly
  const opencode = opencodeOnly ? sources.opencode : {}

  return {
    model:
      cli.model ??
      (claudeModel?.includes("/") ? claudeModel : undefined) ??
      env("CWO_MODEL") ??
      settings.model ??
      opencode.model,
    small:
      cli.smallModel ?? env("CWO_SMALL_MODEL") ?? settings.smallModel ?? opencode.smallModel,
    opus: cli.opusModel ?? env("CWO_OPUS_MODEL") ?? settings.opusModel,
    sonnet: cli.sonnetModel ?? env("CWO_SONNET_MODEL") ?? settings.sonnetModel,
    effort: cli.effort ?? env("CWO_EFFORT") ?? settings.effort,
    opencodeOnly,
  }
}
