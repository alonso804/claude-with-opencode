import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, it } from "node:test"

import { guardClaudeModel, readLastModel, writeLastModel } from "../../dist/claude-settings.js"
import { silent } from "./helpers.mjs"

const isOpenCode = (model) => model.startsWith("opencode-go/")

let file
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "cwo-settings-"))
  process.env.XDG_CACHE_HOME = join(dir, "cache")
  file = join(dir, "settings.json")
  writeFileSync(file, JSON.stringify({ model: "opus", statusLine: { type: "command" } }, null, 2))
  writeLastModel(undefined)
})

// What Claude Code's /model does: rewrite settings.json with the new default.
function pickWithSlashModel(model) {
  const data = JSON.parse(readFileSync(file, "utf8"))
  data.model = model
  writeFileSync(file, JSON.stringify(data, null, 2))
  const later = new Date(Date.now() + 5000)
  utimesSync(file, later, later)
}

const settings = () => JSON.parse(readFileSync(file, "utf8"))

describe("guardClaudeModel", () => {
  it("gives plain claude its model back and remembers the OpenCode one", () => {
    const guard = guardClaudeModel(isOpenCode, silent, file)
    pickWithSlashModel("opencode-go/glm-5.3-flash")
    assert.match(guard.restore(), /opencode-go\/glm-5\.3-flash stays the model for claude-with-opencode; plain claude keeps opus/)
    assert.deepEqual(settings(), { model: "opus", statusLine: { type: "command" } })
    assert.equal(readLastModel(), "opencode-go/glm-5.3-flash")
  })

  it("keeps a Claude model picked with /model and forgets the OpenCode one", () => {
    writeLastModel("opencode-go/glm-5.3")
    const guard = guardClaudeModel(isOpenCode, silent, file)
    pickWithSlashModel("sonnet")
    assert.equal(guard.restore(), undefined)
    assert.equal(settings().model, "sonnet")
    assert.equal(readLastModel(), undefined)
  })

  it("changes nothing when /model was not used", () => {
    writeLastModel("opencode-go/glm-5.3")
    const guard = guardClaudeModel(isOpenCode, silent, file)
    assert.equal(guard.restore(), undefined)
    assert.equal(settings().model, "opus")
    assert.equal(readLastModel(), "opencode-go/glm-5.3")
  })

  it("cleans up an OpenCode model left behind by an earlier session", () => {
    pickWithSlashModel("opencode-go/glm-5.3-flash")
    const guard = guardClaudeModel(isOpenCode, silent, file)
    assert.equal(guard.leftover, "opencode-go/glm-5.3-flash")
    assert.deepEqual(settings(), { statusLine: { type: "command" } })
  })
})
