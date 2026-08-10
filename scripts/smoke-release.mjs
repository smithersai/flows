/**
 * Installs release tarballs into an external temporary project and verifies
 * ESM, CJS, and declaration consumers.
 */
import { spawn } from "node:child_process"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const run = (command, args, cwd) =>
  new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" })
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveRun()
      } else {
        reject(new Error(`${command} exited with ${code ?? signal ?? "unknown status"}`))
      }
    })
  })

const packDirectory = process.argv[2]
if (packDirectory === undefined) {
  throw new Error("usage: node scripts/smoke-release.mjs <pack-directory>")
}

const absolutePackDirectory = resolve(packDirectory)
const packManifest = JSON.parse(
  await readFile(join(absolutePackDirectory, "manifest.json"), "utf8")
)
const expected = new Set(packManifest.map((entry) => entry.filename))
const tarballs = (await readdir(absolutePackDirectory))
  .filter((filename) => filename.endsWith(".tgz"))
  .sort()

if (tarballs.length !== expected.size || tarballs.some((filename) => !expected.has(filename))) {
  throw new Error("release pack directory does not match manifest.json")
}

const smokeRoot = await mkdtemp(join(tmpdir(), "smthrs-release-smoke-"))
try {
  await writeFile(
    join(smokeRoot, "package.json"),
    '{\n  "private": true,\n  "type": "module"\n}\n'
  )
  await run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      ...tarballs.map((filename) => join(absolutePackDirectory, filename)),
      "typescript@6.0.3",
      "vitest@4.1.9"
    ],
    smokeRoot
  )
  await run(
    "node",
    ["--input-type=module", "--eval", "await import('@smthrs/flows')"],
    smokeRoot
  )
  await run(
    "node",
    ["--eval", "require('@smthrs/flows')"],
    smokeRoot
  )
  await writeFile(
    join(smokeRoot, "smoke.mts"),
    [
      'import * as Flows from "@smthrs/flows"',
      'import { runHostContract } from "@smthrs/kernel/test/contract"',
      "",
      "const publicApi: typeof Flows = Flows",
      "void publicApi",
      "void runHostContract",
      ""
    ].join("\n")
  )
  await run(
    "node",
    [
      "node_modules/typescript/bin/tsc",
      "--noEmit",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--target",
      "ES2022",
      "--skipLibCheck",
      "smoke.mts"
    ],
    smokeRoot
  )
} finally {
  await rm(smokeRoot, { recursive: true, force: true })
}
