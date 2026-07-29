import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
const root = resolve(fileURLToPath(new URL("..", import.meta.url)))
const result = spawnSync(process.execPath, [resolve(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"], { cwd: root, stdio: "inherit" })
process.exitCode = result.status ?? 1
