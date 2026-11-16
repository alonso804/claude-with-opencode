# claude-with-opencode

Use [Claude Code](https://code.claude.com) with your Claude models **and** the models you connected in [OpenCode](https://opencode.ai): OpenCode Zen, OpenCode Go, or any other API-key provider in OpenCode's catalog.

It is the mirror image of [opencode-with-claude](https://github.com/ianjwhite99/opencode-with-claude). That plugin adds Claude to OpenCode, next to OpenCode's own providers. This wrapper adds OpenCode's models to Claude Code, next to Claude.

## What this is

A command, `claude-with-opencode`, that starts a small local proxy and then launches `claude` pointed at it. **Start it once** and the proxy comes up with Claude Code. **Quit Claude Code** and the proxy stops. There is no separate server to manage.

The proxy speaks Anthropic's Messages API to Claude Code and routes every request by model name:

- **Claude models** (`opus`, `sonnet`, `haiku`, `claude-*`) are relayed to Anthropic exactly as Claude Code sent them, with Claude Code's own login (claude.ai subscription or API key). Claude works as it does in plain `claude`.
- **OpenCode models** (`provider/model`, e.g. `opencode-go/glm-5.3`) go to that provider, in that model's own protocol, with the API key OpenCode already stores for you.

Features:

- **No new logins**: OpenCode credentials come from OpenCode (`opencode auth export` on OpenCode 2, `auth.json` on 1.x), so whatever you connected with `opencode auth login` just works. Claude keeps using Claude Code's login.
- **OpenCode's catalog**: models are named `provider/model` like in OpenCode (`opencode-go/glm-5.3`, `opencode/gpt-5.5`, ...). Protocol, endpoint and limits come from [models.dev](https://models.dev), the catalog OpenCode itself uses, plus any providers you defined in `opencode.json`.
- **Several windows at once**: every instance gets its own proxy on a free port and its own random token.
- **Claude Code knows what it is talking to**: the real context window, picker names and a `/model` list of OpenCode models are passed to Claude Code, so it compacts at the right time and you can switch models from inside a session.

## How it works

```
                                                claude-* (your Claude login, untouched)
┌─────────────┐            ┌──────────────────────┐ ─────────────▶ ┌──────────────────┐
│ Claude Code │──────────▶ │ claude-with-opencode │                │    Anthropic     │
│  (terminal) │ Anthropic  │   (local proxy on    │                └──────────────────┘
│             │ Messages   │   127.0.0.1:random)  │ provider/model ┌──────────────────┐
│             │◀────────── │                      │ ─────────────▶ │  OpenCode Zen /  │
└─────────────┘            └──────────────────────┘   Anthropic,   │  OpenCode Go /   │
                                       │             Chat Comp.,   │  other providers │
                         API keys from │ opencode     Responses    └──────────────────┘
                                       ▼ auth export
                                  ┌──────────┐
                                  │ OpenCode │
                                  └──────────┘
```

For OpenCode models, the protocol comes from the catalog:

| Model's protocol (from the catalog) | What the proxy does | Examples on Zen / Go |
| --- | --- | --- |
| Anthropic Messages (`@ai-sdk/anthropic`) | Forwards the request almost untouched | Claude models, MiniMax-M3, Qwen3.8 |
| OpenAI Chat Completions (`@ai-sdk/openai-compatible` and most others) | Translates requests, streaming, tool calls and reasoning | GLM, Kimi, DeepSeek, MiMo, Mistral |
| OpenAI Responses (`@ai-sdk/openai`) | Translates, including encrypted reasoning between turns | GPT and Grok models |

Gemini's native API, Vertex, Bedrock and Azure are not supported yet. Those models are hidden from listings and rejected with a clear error.

## Quick start

**1. Requirements**

- Node.js 20 or newer
- Claude Code (`claude` on your PATH)
- OpenCode with at least one provider connected, e.g. `opencode auth login` for OpenCode Zen or Go

**2. Install**

```bash
npm install -g claude-with-opencode
```

**3. Run**

```bash
claude-with-opencode                                    # your usual Claude Code, plus OpenCode models in /model
claude-with-opencode --oc-model opencode-go/glm-5.3     # same, but start the session on GLM-5.3
claude-with-opencode --oc-models                        # list the OpenCode models you can use
```

Everything that does not start with `--oc-` goes to `claude` unchanged:

```bash
claude-with-opencode --oc-model opencode-go/kimi-k3 -p "summarize this repo"
claude-with-opencode --model opus --continue            # a Claude model, as usual
```

To start on an OpenCode model by default, put it in `~/.config/claude-with-opencode/config.json`:

```json
{
  "model": "opencode-go/glm-5.3"
}
```

## Models inside Claude Code

`/model` keeps Claude Code's own Claude rows. After them come the usable models of every OpenCode provider you connected, alphabetically per provider, so a family's models sit together. `/model opencode-go/kimi-k3` or `/model opus` switches at any time, even mid-session.

The picker cannot be searched, but you can type the model instead: `/model kimi-k3` works without the provider. A model typed that way comes from the first provider that has it, in this order: the providers behind your slots, then the others in `--oc-models` order (OpenCode Go before Zen). Names starting with `claude-` always mean Claude.

To shorten the list, set `pickerModels` in the config file. Each entry is a `provider/model`, or a provider id for all of its models, and rows appear in your order:

```json
{
  "pickerModels": ["opencode-go/glm-5.3", "opencode-go/glm-5.3-flash", "opencode-go/kimi-k3", "opencode/gpt-5.5"]
}
```

Claude Code saves a `/model` pick as the default in `~/.claude/settings.json`, but plain `claude` cannot reach an OpenCode model. So when you quit, the wrapper puts that setting back as it was and remembers your OpenCode pick for its own next start. A Claude model you pick stays saved, since plain `claude` can use it.

Claude Code's slots stay Claude unless you pick an OpenCode model for one:

| Claude Code slot | Set with | Otherwise |
| --- | --- | --- |
| Session model (`ANTHROPIC_MODEL`) | `--oc-model`, `"model"` | Claude Code's own default |
| `/model opus` | `--oc-opus-model`, `"opusModel"` | Claude Opus |
| `/model sonnet` | `--oc-sonnet-model`, `"sonnetModel"` | Claude Sonnet |
| Background work: titles, summaries, WebFetch (`haiku`) | `--oc-small-model`, `"smallModel"` | Claude Haiku |

Subagents that ask for `opus`, `sonnet` or `haiku` get the matching slot.

Defaults are resolved in this order, first match wins: `--oc-*` options, `claude --model provider/model`, `CWO_*` environment variables, then the config file.

### OpenCode only

`--oc-only` (or `"opencodeOnly": true`, or `CWO_OPENCODE_ONLY=1`) leaves Claude out entirely. It needs no Claude login and fills every slot with an OpenCode model:

```bash
claude-with-opencode --oc-only --oc-model opencode-go/glm-5.3 --oc-small-model opencode-go/glm-5.3-flash
```

Then `opus`, `sonnet` and `haiku` fall back to the session model, `/model` lists only OpenCode models, and `model` / `small_model` from your OpenCode config also count as defaults.

### What the wrapper sets for Claude Code

| Variable | Value |
| --- | --- |
| `ANTHROPIC_BASE_URL` | `http://127.0.0.1:<port>/<per-run random token>`. The token in the path proves a request comes from this Claude Code, whatever credential it carries |
| `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` | Only the slots you set (all of them with `--oc-only`) |
| `ANTHROPIC_DEFAULT_*_MODEL_NAME` | Catalog names, e.g. `GLM-5.3 (OpenCode Go)`, unless you set them |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` | The real window of an OpenCode session model, unless you set it. Otherwise Claude Code assumes 200k for models it does not know. Claude models are unaffected |
| `--settings <file>` with a `modelPicker` | Only when you pass no `--settings` of your own |
| `ANTHROPIC_AUTH_TOKEN` | With `--oc-only` only: the proxy token, as Claude Code's only credential |

It removes `CLAUDE_CODE_USE_BEDROCK` / `_VERTEX` / `_FOUNDRY`, which would make Claude Code ignore the proxy. With `--oc-only` it also removes `ANTHROPIC_API_KEY`. If you already had an `ANTHROPIC_BASE_URL`, such as a company gateway, Claude requests keep going there instead of `api.anthropic.com`. Plain `claude` keeps working as before.

### Switching between Claude and OpenCode in one session

The conversation carries over. Thinking that an OpenCode model produced is dropped before a request goes to Claude, because Anthropic only accepts its own signed thinking. Claude's thinking is sent to OpenCode models that take reasoning back. Claude Code's attribution line (`x-anthropic-billing-header: ...`), which only Anthropic strips, is removed from OpenCode requests so it does not defeat their prompt caching.

### What providers see

[OpenCode Go](https://opencode.ai/docs/go/#where-can-i-use-it) accepts other coding agents, Claude Code included, but asks each client for two things: its own user agent, and a stable session id per conversation. Without them Go rejects the request ("missing x-opencode-session"). The proxy sends both to every provider:

- `user-agent: claude-with-opencode/<version> (<Claude Code's user agent>)`
- `x-opencode-session`: Claude Code's `x-claude-code-session-id`, with the agent id appended for subagents, since each subagent is a conversation of its own. Claude Code's `x-claude-code-*` headers are forwarded too.

## Configuration

### `~/.config/claude-with-opencode/config.json`

| Key | Meaning |
| --- | --- |
| `model`, `smallModel`, `opusModel`, `sonnetModel` | Slot models (`provider/model`) |
| `opencodeOnly` | `true` for [OpenCode only](#opencode-only) |
| `pickerModels` | What `/model` lists: `provider/model` entries or provider ids, in that order. Default: every usable model of your connected providers |
| `effort` | Reasoning effort sent to OpenCode models that list it (`low`, `high`, `max`, ...). Unset means the provider's default |
| `port` | Fixed proxy port. If it is busy, a free port is used |

### Environment variables

| Variable | Meaning |
| --- | --- |
| `CWO_MODEL`, `CWO_SMALL_MODEL`, `CWO_OPUS_MODEL`, `CWO_SONNET_MODEL`, `CWO_EFFORT`, `CWO_PORT`, `CWO_OPENCODE_ONLY` | Same as the config keys |
| `CWO_ANTHROPIC_URL` | Where Claude requests go. Default: your previous `ANTHROPIC_BASE_URL`, else `https://api.anthropic.com` |
| `OPENCODE_API_KEY` (or any provider's key variable from the catalog) | Used before asking OpenCode. This is the fastest path, see below |
| `CWO_LOG_LEVEL` | `debug`, `info` (default), `warn`, `error` |
| `CLAUDE_PATH`, `OPENCODE_BIN` | Paths to `claude` / `opencode` if they are not on PATH |
| `CWO_MODELS_PATH`, `CWO_MODELS_URL` | Use a local catalog file or another catalog URL |

### Your OpenCode config is honored

Providers in `opencode.json`, global or per project, are layered on top of the catalog. Both OpenCode 1.x keys (`provider.<id>.options`) and OpenCode 2 keys (`providers.<id>.settings`) work. That covers custom base URLs, keys, headers and your own providers, such as a local OpenAI-compatible server:

```json
{
  "providers": {
    "local": {
      "package": "@ai-sdk/openai-compatible",
      "settings": { "baseURL": "http://localhost:11434/v1", "apiKey": "ollama" },
      "models": { "qwen": { "id": "qwen3:32b", "name": "Qwen 3 32B" } }
    }
  }
}
```

A provider whose base URL you overrode, for example `anthropic` pointed at the opencode-with-claude proxy, is used as configured. `--oc-models` shows the override.

### Credentials

For each provider, the first of these that has a key wins:

1. `apiKey` for that provider in your OpenCode config
2. The provider's environment variables from the catalog (`OPENCODE_API_KEY` for Zen and Go)
3. OpenCode 1.x `~/.local/share/opencode/auth.json`
4. OpenCode 2 `opencode auth export` (active API-key credentials only)

Keys only live in the wrapper's memory. They are never logged or written to disk. Claude Code's own Claude credential passes through the proxy to Anthropic and is never read, logged or sent to OpenCode.

`opencode auth export` goes through OpenCode's background service. It answers in well under a second when the service is up, but can take 15-20 seconds to start it. The wrapper starts the export while Claude Code is booting, so usually you don't notice. A `-p` one-shot may wait for it on the first request. Exporting `OPENCODE_API_KEY` skips the step entirely.

To list OpenCode models in `/model` right away, the wrapper remembers which providers were connected last time, by id only, in `~/.cache/claude-with-opencode/connected-providers.json`. It refreshes that list in the background. Only the very first start waits for the export.

OAuth logins, such as GitHub Copilot or a ChatGPT subscription connected to OpenCode, are not used. Only API keys are.

## Troubleshooting

**Where are the logs?** In `~/.cache/claude-with-opencode/proxy.log`. There is one line per request, with model, protocol, status, latency and token counts. Prompts and keys are never logged. Use `CWO_LOG_LEVEL=debug` for more detail.

**"--oc-only needs a model"**: pass `--oc-model`, or set `"model"` in the config file. The message suggests one of your models.

**A Claude model fails but plain `claude` works**: check the log for the `anthropic [passthrough]` line and its status. Requests go to `CWO_ANTHROPIC_URL`, your previous `ANTHROPIC_BASE_URL`, or `api.anthropic.com`.

**"No API key for provider ..."**: connect the provider in OpenCode (`opencode auth login`) or export its key variable. Check that `opencode auth export` works in your shell. The log says why the export failed. If several `opencode` installs are on PATH (for example one per Node version under a version manager), set `OPENCODE_BIN` to the one you use.

**"... needs @ai-sdk/google, which claude-with-opencode cannot translate yet"**: that model uses a protocol the proxy does not speak (see the table above). Pick another model.

**The first answer of a `-p` run is slow**: see [Credentials](#credentials). Set `OPENCODE_API_KEY`.

**Run the proxy on its own**: `claude-with-opencode --oc-model opencode-go/glm-5.3 --oc-serve` prints the environment (bash and PowerShell) for starting `claude` yourself.

## Limitations

- Claude Code's **WebSearch** relies on Anthropic's server-side search tool. It works with Claude models. OpenCode models cannot search.
- **Images and PDFs** reach a model only if the catalog says it reads them. Otherwise they are replaced with a short note.
- **Token counting** (`/context`) is an estimate. Real usage from the provider is reported after each response.
- Reasoning from GLM, Kimi, DeepSeek and others shows up as Claude Code "thinking" and is sent back to the model on later turns, as those models expect. GPT reasoning round-trips as encrypted content and is bound to the model that produced it.

## Development

```
claude-with-opencode/
├── src/
│   ├── cli.ts              # Entry point: options, proxy lifecycle, launches claude
│   ├── proxy.ts            # Local Anthropic-compatible HTTP server
│   ├── upstream.ts         # Forwards a request in the model's protocol
│   ├── translate/          # Anthropic <-> Chat Completions / Responses, Anthropic passthrough
│   ├── message-builder.ts  # Builds Anthropic messages and SSE events
│   ├── catalog.ts          # models.dev catalog, routing (protocol + URL per model)
│   ├── credentials.ts      # API keys from config, env, auth.json, opencode auth export
│   ├── opencode-config.ts  # Reads opencode.json(c), both generations
│   ├── picker.ts           # /model lineup, slot labels, context window
│   ├── settings.ts         # This tool's config and default resolution
│   └── process.ts          # Finding and spawning claude / opencode (Windows-safe)
└── test/
    ├── unit/               # node:test suites (npm run test:unit)
    └── smoke-claude.mjs    # Real Claude Code against a fake provider (npm run test:claude)
```

```bash
npm install
npm run build
npm run test:unit     # translators, routing, credentials, proxy end to end
npm run test:claude   # runs the real `claude -p` through the proxy, three ways
```

`test:claude` needs no network or credentials. It points Claude Code at a fake OpenAI-compatible provider and a fake Anthropic, then checks three runs:

- an OpenCode model's full tool loop next to Claude;
- a Claude model relayed untouched, with Claude Code's own key;
- the tool loop again with `--oc-only`.

## Inspiration

This project was inspired by [ianjwhite99/opencode-with-claude](https://github.com/ianjwhite99/opencode-with-claude), an OpenCode plugin that lets you use your Claude subscription inside OpenCode. `claude-with-opencode` goes the other way: it brings OpenCode's models into Claude Code. Thanks to Ian White for the idea.

## Disclaimer

This is an unofficial tool. It is not affiliated with, endorsed by, or supported by Anthropic or OpenCode. It calls each OpenCode provider's public API with your own API key. Claude requests are Claude Code's own, relayed unchanged. Review the terms of the providers you use, including OpenCode Zen and OpenCode Go, and make sure they allow use from Claude Code.
