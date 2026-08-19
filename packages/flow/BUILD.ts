/**
 * Standard package targets, written as `StandardPackage` desugared into its
 * six rule calls.
 *
 * These targets are executable and must stay equivalent to what
 * `StandardPackage({ cwd: "packages/flow", deps: [plan] })`
 * emits; the file exists to show the expansion, not to diverge from it.
 */
import { Smithers } from "@smthrs/targets"
import { lib as plan } from "../plan/BUILD.ts"

const cwd = "packages/flow"
const sources = Smithers.glob("src/**/*.ts")
const tests = Smithers.glob("test/**/*.test.ts")

export const lib = Smithers.TsBuild({
  srcs: [sources],
  entries: [Smithers.file("src/index.ts")],
  deps: [plan],
  tsconfig: Smithers.file("tsconfig.json"),
  tool: "tsc",
  format: "dual",
  outDir: "dist",
  external: [],
  cwd
})

export const check = Smithers.Typecheck({
  srcs: [sources, Smithers.glob("test/**/*.ts")],
  deps: [lib, plan],
  tsconfig: Smithers.file("tsconfig.test.json"),
  buildMode: false,
  incremental: false,
  cwd
})

export const test = Smithers.Vitest({
  tests: [tests],
  sources: [sources],
  deps: [lib, plan],
  config: Smithers.file("vitest.config.ts"),
  environment: "node",
  passWithNoTests: false,
  cwd
})

export const lint = Smithers.EsLint({
  sources: [sources],
  deps: [],
  configs: [Smithers.file("eslint.config.js"), Smithers.file("//eslint.jsdoc.js")],
  maxWarnings: 0,
  fix: false,
  cwd
})

export const fmt = Smithers.Dprint({
  sources: [sources, Smithers.glob("test/**/*.ts")],
  deps: [],
  config: Smithers.file("dprint.json"),
  fix: false,
  cwd
})

export const docs = Smithers.DocsParity({
  readme: Smithers.file("README.md"),
  deps: [],
  cwd
})
