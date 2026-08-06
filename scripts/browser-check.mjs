/**
 * The browser contract, executed.
 *
 * Browser support is a hard requirement of this repository, and it is met the
 * only way an Effect codebase can meet it: platform access lives in layers, and
 * the entry points that expose contracts never statically resolve a `node:`
 * built-in. This script pins both halves of that promise.
 *
 * `BROWSER_SAFE` entries MUST bundle under `--platform=browser`. `NODE_ONLY`
 * entries MUST still fail, and fail only because a documented `node:` built-in
 * is unresolvable — so a Node dependency can neither creep into a browser entry
 * point nor silently disappear from a documented Node-only one without this
 * gate saying so.
 *
 * Run it with `npm run browser` from the repository root.
 */
import { relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..")

/**
 * Entry points that are part of the browser promise. Each is bundled for the
 * browser; any resolution or syntax error fails the gate.
 */
const BROWSER_SAFE = [
  { name: "@smithers/host", entry: "packages/host/src/index.ts" },
  { name: "@smithers/host/browser/BrowserHost", entry: "packages/host/src/browser/BrowserHost.ts" },
  { name: "@smithers/kernel", entry: "packages/kernel/src/index.ts" },
  { name: "@smithers/keys", entry: "packages/keys/src/index.ts" },
  { name: "@smithers/database", entry: "packages/database/src/index.ts" },
  { name: "@smithers/journal", entry: "packages/journal/src/index.ts" },
  { name: "@smithers/engine", entry: "packages/engine/src/index.ts" },
  { name: "@smithers/plugin", entry: "packages/plugin/src/index.ts" },
  { name: "@smithers/sync", entry: "packages/sync/src/index.ts" },
  { name: "@smithers/time-travel", entry: "packages/time-travel/src/index.ts" }
]

/**
 * Entry points documented as Node-only. The `expect` module is the `node:`
 * built-in the documentation names as the reason; if an entry stops failing —
 * or starts failing for some other reason — the docs and this list are wrong.
 */
const NODE_ONLY = [
  {
    name: "@smithers/engine-store",
    entry: "packages/engine-store/src/index.ts",
    expect: "node:crypto",
    reason: "EngineStore uses process.pid and node:crypto randomUUID (issue #114)"
  },
  {
    name: "@smithers/flows",
    entry: "packages/flows/src/index.ts",
    expect: "node:crypto",
    reason: "the barrel re-exports @smithers/engine-store; browser consumers import per-package roots"
  },
  {
    name: "@smithers/host/node/NodeHost",
    entry: "packages/host/src/node/NodeHost.ts",
    expect: "node:child_process",
    reason: "the Node host bundle spawns child processes"
  },
  {
    name: "@smithers/database/node/NodeDatabase",
    entry: "packages/database/src/node/NodeDatabase.ts",
    expect: "node:sqlite",
    reason: "the Node database layer is node:sqlite through @effect/sql-sqlite-node"
  }
]

const esbuild = await import("esbuild").catch((cause) => {
  console.error("browser-check needs esbuild from the workspace toolchain — run `npm ci` first.")
  console.error(cause)
  process.exit(1)
})

const bundle = (entry) =>
  esbuild.build({
    entryPoints: [resolve(repoRoot, entry)],
    absWorkingDir: repoRoot,
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    target: "es2022",
    logLevel: "silent"
  })

const kilobytes = (bytes) => `${(bytes / 1024).toFixed(1)} kB`

/** An esbuild error is an unresolved `node:` built-in for `module`. */
const isUnresolved = (error, module) =>
  error.text.includes(`Could not resolve "${module}"`) ||
  (error.notes ?? []).some((note) => note.text.includes(`The package "${module}"`))

/** Every esbuild error is an unresolved `node:` built-in of some kind. */
const isNodeBuiltinOnly = (errors) => errors.every((error) => /Could not resolve "node:/.test(error.text))

/** esbuild errors, at most five, one indented line each. */
const detail = (errors) => {
  const shown = errors.slice(0, 5).map((error) => {
    const where = error.location ? ` (${error.location.file}:${error.location.line})` : ""
    return `  ${error.text}${where}`
  })
  return errors.length > 5 ? [...shown, `  …and ${errors.length - 5} more`] : shown
}

/** Whatever esbuild rejected with, as an error list. */
const errorsOf = (rejection) =>
  Array.isArray(rejection.errors) && rejection.errors.length > 0
    ? rejection.errors
    : [{ text: String(rejection?.message ?? rejection) }]

const failures = []

for (const { entry, name } of BROWSER_SAFE) {
  try {
    const result = await bundle(entry)
    const bytes = result.outputFiles.reduce((total, file) => total + file.contents.byteLength, 0)
    console.log(`browser ok    ${name} (${relative(repoRoot, entry)}, ${kilobytes(bytes)})`)
  } catch (rejection) {
    failures.push(
      `${name} is a browser entry point but does not bundle for the browser:`,
      ...detail(errorsOf(rejection))
    )
  }
}

for (const { entry, expect, name, reason } of NODE_ONLY) {
  let bundled = false
  try {
    await bundle(entry)
    bundled = true
  } catch (rejection) {
    const errors = errorsOf(rejection)
    if (!isNodeBuiltinOnly(errors)) {
      failures.push(
        `${name} is documented Node-only, but it fails for a reason other than a node: built-in:`,
        ...detail(errors)
      )
    } else if (!errors.some((error) => isUnresolved(error, expect))) {
      failures.push(
        `${name} is documented Node-only because of ${expect}, but that import is gone.`,
        "  Update the docs and this list.",
        ...detail(errors)
      )
    } else {
      console.log(`node only     ${name} (${expect}: ${reason})`)
    }
  }
  if (bundled) {
    failures.push(
      `${name} is documented Node-only, but it now bundles for the browser.`,
      "  Promote it to BROWSER_SAFE and fix the docs."
    )
  }
}

if (failures.length > 0) {
  console.error("")
  console.error("browser contract violated:")
  for (const failure of failures) console.error(failure)
  process.exitCode = 1
} else {
  console.log("")
  console.log(`browser contract holds: ${BROWSER_SAFE.length} browser entry points, ${NODE_ONLY.length} Node-only.`)
}
