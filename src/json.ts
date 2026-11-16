export type JsonObject = Record<string, unknown>

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function parseJSON(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Objects merge recursively; arrays and scalars from `b` replace `a`'s. */
export function deepMerge(a: JsonObject, b: JsonObject): JsonObject {
  const out: JsonObject = { ...a }
  for (const [key, value] of Object.entries(b)) {
    const current = out[key]
    out[key] = isObject(value) && isObject(current) ? deepMerge(current, value) : value
  }
  return out
}

/**
 * Parses JSON with comments and trailing commas, the dialect OpenCode accepts
 * for `opencode.json(c)`.
 */
export function parseJsonc(text: string): unknown {
  return JSON.parse(removeTrailingCommas(removeComments(text.replace(/^﻿/, ""))))
}

function removeComments(text: string): string {
  let out = ""
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      out += ch
      if (ch === "\\") out += text[++i] ?? ""
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++
      out += "\n"
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2)
      i = end === -1 ? text.length : end + 1
    } else {
      out += ch
    }
  }
  return out
}

function removeTrailingCommas(text: string): string {
  let out = ""
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      out += ch
      if (ch === "\\") out += text[++i] ?? ""
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    if (ch === ",") {
      let j = i + 1
      while (j < text.length && /\s/.test(text[j])) j++
      if (text[j] === "}" || text[j] === "]") continue
    }
    out += ch
  }
  return out
}
