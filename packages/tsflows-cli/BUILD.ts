/**
 * Standard package targets for a private, unbuilt package.
 *
 * This package ships no distribution: its tsconfig sets `noEmit`, so the
 * synthesized TsBuild `lib` target could never produce the `dist` tree it
 * declares. `lib` is therefore a Typecheck over the package tsconfig — the
 * same compiler run the build would perform, minus the emit — and keeps the
 * conventional label so dependents and the default-target convention are
 * unchanged.
 */
import { DocsParity, Dprint, EsLint, file, glob, Typecheck, Vitest } from "tsflows-rules"
import { rootJSDocConfig } from "../../BUILD.ts"

const cwd = "packages/tsflows-cli"
const sources = glob("src/**/*.ts")
const tests = glob("test/**/*.test.ts")

export const lib = Typecheck({
  srcs: [sources],
  deps: [],
  tsconfig: file("tsconfig.json"),
  buildMode: false,
  incremental: false,
  cwd
})

export const check = Typecheck({
  srcs: [sources, glob("test/**/*.ts")],
  deps: [lib],
  tsconfig: file("tsconfig.test.json"),
  buildMode: false,
  incremental: false,
  cwd
})

export const test = Vitest({
  tests: [tests],
  sources: [sources],
  deps: [lib],
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
