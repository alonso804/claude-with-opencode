import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"

export type Level = "debug" | "info" | "warn" | "error"
export type LogFn = (level: Level, message: string) => void

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

function threshold(): number {
  const level = process.env.CWO_LOG_LEVEL?.toLowerCase()
  return level && level in ORDER ? ORDER[level as Level] : ORDER.info
}

/**
 * Claude Code owns the terminal while it runs, so anything the proxy prints
 * would corrupt its UI. Requests are logged to a file instead.
 */
export function createFileLogger(file: string): LogFn {
  const min = threshold()
  let ready = false
  return (level, message) => {
    if (ORDER[level] < min) return
    try {
      if (!ready) {
        mkdirSync(dirname(file), { recursive: true })
        ready = true
      }
      appendFileSync(
        file,
        `${new Date().toISOString()} ${level.toUpperCase()} ${message}\n`,
      )
    } catch {
      // Logging must never take the proxy down.
    }
  }
}

export function createConsoleLogger(): LogFn {
  const min = threshold()
  return (level, message) => {
    if (ORDER[level] < min) return
    const prefix = level === "info" ? "" : `${level}: `
    process.stderr.write(`claude-with-opencode: ${prefix}${message}\n`)
  }
}
