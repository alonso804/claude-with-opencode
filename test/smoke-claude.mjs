// End-to-end check with the real Claude Code CLI against fake providers: no
// network, no real credentials. Three runs:
//
//   1. OpenCode model alongside Claude: Claude Code must call its Read tool
//      through the proxy and answer with what the tool returned.
//   2. Claude model alongside OpenCode: the request must reach "Anthropic"
//      untouched, with Claude Code's own credential.
//   3. --oc-only: the OpenCode tool loop again, with no Anthropic credential.
//
//   npm run test:claude
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const work = mkdtempSync(join(tmpdir(), "cwo-smoke-"))
const secretFile = join(work, "note.txt")
writeFileSync(secretFile, "PINEAPPLE-42\n")

async function serve(handler) {
  const requests = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")
    requests.push({ method: req.method, url: req.url, body, headers: req.headers })
    handler({ url: req.url, body }, res)
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  return {
    requests,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => {
      server.close()
      server.closeAllConnections()
    },
  }
}

// A fake OpenAI-compatible provider that asks for a Read, then reports it.
const opencode = await serve(({ body }, res) => {
  const toolMessage = body.messages?.findLast?.((message) => message.role === "tool")
  const wantsRead =
    JSON.stringify(body.messages ?? []).includes("note.txt") && body.tools?.some((tool) => tool.function?.name === "Read")
  let chunks
  if (toolMessage) {
    const seen = String(toolMessage.content).includes("PINEAPPLE-42") ? "PINEAPPLE-42" : "(not found)"
    chunks = [{ choices: [{ delta: { content: `The file says: ${seen}` }, finish_reason: "stop" }] }]
  } else if (wantsRead) {
    chunks = [
      { choices: [{ delta: { reasoning_content: "I will read the file." } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_read_1", type: "function", function: { name: "Read", arguments: "" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ file_path: secretFile }) } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ]
  } else {
    // Claude Code's side requests (titles, summaries, ...).
    chunks = [{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]
  }
  res.writeHead(200, { "content-type": "text/event-stream" })
  for (const chunk of [...chunks, { choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } }]) {
    res.write(`data: ${JSON.stringify(chunk)}\n\n`)
  }
  res.end("data: [DONE]\n\n")
})

// A fake api.anthropic.com that answers every Messages call with one line.
const anthropic = await serve(({ url, body }, res) => {
  if (!url.startsWith("/v1/messages")) {
    res.writeHead(404, { "content-type": "application/json" })
    return res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "fake" } }))
  }
  if (!body.stream) {
    res.writeHead(200, { "content-type": "application/json" })
    return res.end(JSON.stringify({ id: "msg_f", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: "HELLO-FROM-CLAUDE" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 5, output_tokens: 3 } }))
  }
  const events = [
    ["message_start", { type: "message_start", message: { id: "msg_f", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "HELLO-FROM-CLAUDE" } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }],
    ["message_stop", { type: "message_stop" }],
  ]
  res.writeHead(200, { "content-type": "text/event-stream" })
  for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  res.end()
})

const home = (name) => {
  const dir = join(work, name)
  mkdirSync(dir, { recursive: true })
  return dir
}
const emptyCatalog = join(work, "catalog.json")
writeFileSync(emptyCatalog, "{}")

const baseEnv = {
  ...process.env,
  // Isolate from the user's OpenCode and Claude Code setup.
  XDG_CONFIG_HOME: home("config"),
  XDG_CACHE_HOME: home("cache"),
  XDG_DATA_HOME: home("data"),
  CLAUDE_CONFIG_DIR: home("claude"),
  CWO_MODELS_PATH: emptyCatalog,
  CWO_ANTHROPIC_URL: anthropic.url,
  // Stands in for the user's Claude login; only "Anthropic" may receive it.
  ANTHROPIC_API_KEY: "sk-ant-smoke-test",
  OPENCODE_CONFIG_CONTENT: JSON.stringify({
    provider: {
      fake: {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: `${opencode.url}/v1`, apiKey: "fake-key" },
        models: {
          echo: {
            name: "Echo",
            tool_call: true,
            interleaved: { field: "reasoning_content" },
            limit: { context: 300000, output: 8000 },
          },
        },
      },
    },
  }),
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  CWO_LOG_LEVEL: "debug",
}
// This script may itself run inside Claude Code.
delete baseEnv.CLAUDECODE
delete baseEnv.OPENCODE_CONFIG
delete baseEnv.ANTHROPIC_BASE_URL
delete baseEnv.ANTHROPIC_AUTH_TOKEN

async function run(args) {
  const child = spawn(process.execPath, [join(root, "dist", "cli.js"), ...args, "--output-format", "text"], {
    cwd: work,
    env: baseEnv,
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk) => (stdout += chunk))
  child.stderr.on("data", (chunk) => (stderr += chunk))
  const timer = setTimeout(() => child.kill(), 180_000)
  const code = await new Promise((resolve) => child.on("close", resolve))
  clearTimeout(timer)
  return { code, stdout: stdout.trim(), stderr: stderr.trim() }
}

const checks = []
const check = (name, ok) => {
  checks.push(ok)
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`)
}
const readPrompt = ["-p", `Read the file ${secretFile} and tell me exactly what it says.`, "--allowedTools", "Read"]

function checkToolLoop(label, result, requests) {
  check(`${label}: exit code 0`, result.code === 0)
  check(`${label}: answer comes from the tool result`, result.stdout.includes("PINEAPPLE-42"))
  check(
    `${label}: tool result reached the model`,
    requests.some((r) => r.body.messages?.some((m) => m.role === "tool" && String(m.content).includes("PINEAPPLE-42"))),
  )
  check(
    `${label}: reasoning sent back with the tool call`,
    requests.some((r) => r.body.messages?.some((m) => m.role === "assistant" && m.reasoning_content === "I will read the file.")),
  )
  check(`${label}: context window passed to Claude Code`, !/assumes a context window of 200k/.test(result.stderr))
  check(`${label}: max_tokens clamped to the model's limit`, requests.every((r) => !(r.body.max_tokens > 8000)))
  const sessions = new Set(requests.map((r) => r.headers["x-opencode-session"]))
  check(`${label}: one stable x-opencode-session`, !sessions.has(undefined) && sessions.size === 1)
  check(
    `${label}: no attribution line reaches the provider`,
    requests.every((r) => !String(r.body.messages?.[0]?.content ?? "").startsWith("x-anthropic-billing-header")),
  )
  check(`${label}: Claude credential never reaches OpenCode`, requests.every((r) => !JSON.stringify(r.headers).includes("sk-ant-smoke-test")))
}

// 1. OpenCode model, Claude still available.
let result = await run(["--oc-model", "fake/echo", ...readPrompt])
if (result.code !== 0) console.log(result.stdout, result.stderr)
checkToolLoop("alongside Claude, OpenCode model", result, opencode.requests)
check("alongside Claude, OpenCode model: Anthropic untouched", anthropic.requests.length === 0)

// 2. Claude model, OpenCode models still available.
const before = opencode.requests.length
result = await run(["--model", "claude-haiku-4-5", "-p", "Say hello."])
if (result.code !== 0) console.log(result.stdout, result.stderr)
const toClaude = anthropic.requests.filter((r) => r.url.startsWith("/v1/messages"))
check("alongside OpenCode, Claude model: exit code 0", result.code === 0)
check("alongside OpenCode, Claude model: answer relayed", result.stdout.includes("HELLO-FROM-CLAUDE"))
check("alongside OpenCode, Claude model: Claude Code's own key reaches Anthropic", toClaude.length > 0 && toClaude.every((r) => r.headers["x-api-key"] === "sk-ant-smoke-test"))
check("alongside OpenCode, Claude model: proxy token not forwarded", toClaude.every((r) => /^\/v1\/messages/.test(r.url)))
check("alongside OpenCode, Claude model: nothing sent to OpenCode", opencode.requests.length === before)

// 2b. An OpenCode model typed without its provider, as in `/model echo`.
const beforeBare = opencode.requests.length
const claudeBefore = anthropic.requests.length
result = await run(["--model", "echo", "-p", "Say hello."])
if (result.code !== 0) console.log(result.stdout, result.stderr)
check("model typed without its provider: exit code 0", result.code === 0)
check(
  "model typed without its provider: reaches OpenCode",
  opencode.requests.slice(beforeBare).some((r) => r.body.model === "echo") && anthropic.requests.length === claudeBefore,
)

// 3. OpenCode only.
const startOnly = opencode.requests.length
result = await run(["--oc-only", "--oc-model", "fake/echo", ...readPrompt])
if (result.code !== 0) console.log(result.stdout, result.stderr)
checkToolLoop("--oc-only", result, opencode.requests.slice(startOnly))

opencode.close()
anthropic.close()
const ok = checks.every(Boolean)
if (ok) rmSync(work, { recursive: true, force: true })
else console.log(`kept ${work} for inspection (proxy log: ${join(work, "cache", "claude-with-opencode", "proxy.log")})`)
console.log(ok ? "SMOKE TEST PASSED" : "SMOKE TEST FAILED")
process.exit(ok ? 0 : 1)
