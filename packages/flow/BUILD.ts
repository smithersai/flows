/**
 * Standard package targets, written as `StandardPackage` desugared into its
 * six rule calls.
 *
 * These targets are executable and must stay equivalent to what
 * `StandardPackage({ cwd: "packages/flow", deps: [plan] })` emits; the file
 * exists to show the expansion, not to diverge from it.
 */
import { DocsParity, Dprint, EsLint, file, glob, TsBuild, Typecheck, Vitest } from "tsflows-rules"
import { rootJSDocConfig } from "../../BUILD.ts"
import { lib as plan } from "../plan/BUILD.ts"

const cwd = "packages/flow"
const sources = glob("src/**/*.ts")
const tests = glob("test/**/*.test.ts")

export const lib = TsBuild({
  srcs: [sources],
  entries: [file("src/index.ts")],
  deps: [plan],
  tsconfig: file("tsconfig.json"),
  tool: "tsc",
  format: "dual",
  outDir: "dist",
  external: [],
  cwd
})

export const check = Typecheck({
  srcs: [sources, glob("test/**/*.ts")],
  deps: [lib, plan],
  tsconfig: file("tsconfig.test.json"),
  buildMode: false,
  incremental: false,
  cwd
})

export const test = Vitest({
  tests: [tests],
  sources: [sources],
  deps: [lib, plan],
  config: file("vitest.config.ts"),
  environment: "node",
  passWithNoTests: false,
  cwd
})

export const lint = EsLint({
  sources: [sources],
  deps: [],
  configs: [file("eslint.config.js"), rootJSDocConfig],
  maxWarnings: 0,
  fix: false,
  cwd
})

export const fmt = Dprint({
  sources: [sources, glob("test/**/*.ts")],
  deps: [],
  config: file("dprint.json"),
  fix: false,
  cwd
})

export const docs = DocsParity({
  readme: file("README.md"),
  deps: [],
  cwd
})
