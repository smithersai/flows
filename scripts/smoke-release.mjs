/**
 * Installs release tarballs into an external temporary project and verifies
 * ESM, CJS, and declaration consumers.
 */
import { spawn } from "node:child_process"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const repoRoot = resolve(import.meta.dirname, "..")

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
  // The packages are not published yet, and pnpm resolves each transitive
  // exact-version edge independently even when every tarball is also passed
  // to `pnpm add`. Override those internal edges to the tarballs under test so
  // the smoke project cannot fall back to an older registry copy.
  await writeFile(
    join(smokeRoot, "pnpm-workspace.yaml"),
    [
      "overrides:",
      ...packManifest.map((entry) =>
        `  ${JSON.stringify(entry.name)}: ${JSON.stringify(`file:${join(absolutePackDirectory, entry.filename)}`)}`
      ),
      ""
    ].join("\n")
  )
  await run(
    "pnpm",
    [
      "--dir",
      smokeRoot,
      "add",
      "--ignore-scripts",
      ...tarballs.map((filename) => join(absolutePackDirectory, filename)),
      "typescript@6.0.3",
      "vitest@4.1.9"
    ],
    repoRoot
  )
  await run(
    "node",
    ["--input-type=module", "--eval", "await import('@smthrs/flows-next')"],
    smokeRoot
  )
  await run(
    "node",
    ["--eval", "require('@smthrs/flows-next')"],
    smokeRoot
  )
  await writeFile(
    join(smokeRoot, "smoke.mts"),
    [
      'import * as Flows from "@smthrs/flows-next"',
      'import { runHostContract } from "@smthrs/kernel-next/test/contract"',
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
