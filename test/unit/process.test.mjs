import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { captureOutput, findExecutable } from "../../dist/process.js"

const windows = process.platform === "win32"

describe("captureOutput", () => {
  // npm installs CLIs such as opencode as .cmd shims that start a console
  // program. Its output must still reach us, with arguments intact.
  it("reads the output of a program started by a .cmd shim", { skip: !windows }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "cwo shim "))
    writeFileSync(join(dir, "echo-args.js"), "console.log(JSON.stringify(process.argv.slice(2)))\n")
    writeFileSync(
      join(dir, "echo-args.cmd"),
      `@ECHO off\r\n"${process.execPath}" "%~dp0echo-args.js" %*\r\n`,
    )
    const shim = join(dir, "echo-args.cmd")
    const output = await captureOutput(shim, ["auth", "export", "a b", 'q"uote', "100%"], { timeoutMs: 30_000 })
    assert.deepEqual(JSON.parse(output), ["auth", "export", "a b", 'q"uote', "100%"])
  })

  it("rejects on a non-zero exit", async () => {
    await assert.rejects(
      captureOutput(process.execPath, ["-e", "console.error('boom'); process.exit(3)"], { timeoutMs: 30_000 }),
      /exited with code 3: boom/,
    )
  })
})

describe("findExecutable", () => {
  it("finds node and honours an explicit override", () => {
    assert.ok(findExecutable("node"))
    assert.equal(findExecutable("node", process.execPath), process.execPath)
    assert.equal(findExecutable("node", join(tmpdir(), "no-such-binary")), undefined)
  })
})
