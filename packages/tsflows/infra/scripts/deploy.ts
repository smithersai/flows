import { spawn } from "node:child_process"
import * as NodePath from "node:path"
import { fileURLToPath } from "node:url"
import { redactAlchemyState } from "./redact-state.ts"

const infraDirectory = NodePath.dirname(NodePath.dirname(fileURLToPath(import.meta.url)))
const alchemyCli = NodePath.join(infraDirectory, "node_modules", "alchemy", "bin", "cli.js")

const runAlchemy = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [alchemyCli, "deploy", "alchemy.run.ts", ...process.argv.slice(2)],
      {
        cwd: infraDirectory,
        env: process.env,
        stdio: "inherit"
      }
    )
    child.once("error", reject)
    child.once("close", (code) => resolve(code ?? 1))
  })

try {
  const exitCode = await runAlchemy()
  const redactedFiles = await redactAlchemyState()
  process.stdout.write(`Redacted ${redactedFiles} Alchemy Worker state file(s).\n`)
  process.exitCode = exitCode
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
