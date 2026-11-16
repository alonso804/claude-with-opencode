// Runs every test/unit/*.test.mjs with node:test. Globs in npm scripts are
// not portable (cmd.exe does not expand them and Node 20 does not either).
import { spawnSync } from "node:child_process"
import { readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const dir = join(dirname(fileURLToPath(import.meta.url)), "unit")
const files = readdirSync(dir)
  .filter((name) => name.endsWith(".test.mjs"))
  .map((name) => join(dir, name))

const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" })
process.exit(result.status ?? 1)
