// What Claude Code's `/model` picker shows for OpenCode models.

import { resolveRoute, usableModels, type CatalogModel, type Protocol, type Providers, type Route } from "./catalog.js"
import type { ModelDefaults } from "./settings.js"

const SLOTS = ["model", "small", "opus", "sonnet"] as const
type Slot = (typeof SLOTS)[number]

export const PROTOCOL_LABEL: Record<Protocol, string> = {
  anthropic: "anthropic",
  "openai-chat": "chat",
  "openai-responses": "responses",
}

export function modelLabel(route: Route): string {
  return `${route.model.name ?? route.modelID} (${route.provider.name ?? route.providerID})`
}

export function slotLabels(providers: Providers, defaults: ModelDefaults): Partial<Record<Slot, string>> {
  const labels: Partial<Record<Slot, string>> = {}
  for (const slot of SLOTS) {
    const ref = defaults[slot]
    if (ref) labels[slot] = modelLabel(resolveRoute(providers, ref))
  }
  return labels
}

/** The window Claude Code should compact against, from the catalog. */
export function contextWindow(model: CatalogModel): number | undefined {
  const window = Math.min(model.limit?.input ?? Infinity, model.limit?.context ?? Infinity)
  return Number.isFinite(window) && window > 0 ? window : undefined
}

export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${+(count / 1_000_000).toFixed(1)}M`
  return `${Math.round(count / 1000)}k`
}

/**
 * The OpenCode providers in play, most relevant first: those behind Claude
 * Code's slots, then the ones you connected. This order decides which
 * provider a model typed without its provider comes from.
 */
export function providerOrder(defaults: ModelDefaults, connected: string[] = []): string[] {
  return [
    ...new Set([
      ...SLOTS.map((slot) => defaults[slot])
        .filter((ref): ref is string => !!ref && ref.includes("/"))
        .map((ref) => ref.slice(0, ref.indexOf("/"))),
      // Claude Code lists Claude itself; OpenCode's `anthropic` provider would
      // only duplicate it (or point at a proxy such as opencode-with-claude).
      ...connected.filter((id) => defaults.opencodeOnly || id !== "anthropic"),
    ]),
  ]
}

/**
 * A `modelPicker` lineup (passed with `claude --settings`). By default it
 * lists every usable model of the providers in play, alphabetically per
 * provider so a family's models sit together. `only` narrows it to the
 * entries you listed, in your order: `provider/model`, or a provider id for
 * all of its models. Alongside Claude the rows come after Claude Code's own
 * lineup; with `--oc-only` they replace it, since Claude cannot be served then.
 */
export function modelPickerSettings(
  providers: Providers,
  defaults: ModelDefaults,
  connected: string[] = [],
  only?: string[],
) {
  const rows = new Map<string, Route>()
  const addProvider = (id: string) => {
    const provider = providers[id]
    if (!provider) return
    const routes = usableModels(provider).map(([key]) => resolveRoute(providers, `${id}/${key}`))
    routes.sort((a, b) => modelLabel(a).localeCompare(modelLabel(b), undefined, { numeric: true }))
    for (const route of routes) rows.set(route.ref, route)
  }

  if (only?.length) {
    for (const entry of only) {
      if (!entry.includes("/")) addProvider(entry)
      else {
        try {
          const route = resolveRoute(providers, entry)
          rows.set(route.ref, route)
        } catch {
          // unknown or unsupported: nothing to show
        }
      }
    }
  } else {
    for (const id of providerOrder(defaults, connected)) addProvider(id)
  }

  const options = [...rows.values()].map((route) => {
    const window = contextWindow(route.model)
    return {
      model: route.ref,
      label: modelLabel(route),
      description: [route.ref, window && `${formatTokens(window)} context`, PROTOCOL_LABEL[route.protocol]]
        .filter(Boolean)
        .join(" · "),
    }
  })
  return options.length ? { modelPicker: { options, replaceBuiltInOptions: defaults.opencodeOnly } } : undefined
}
