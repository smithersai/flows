/**
 * Standard package targets for a private, unbuilt package.
 *
 * This package ships no distribution: its manifest is `"private": true` and
 * declares no build script, so the synthesized TsBuild `lib` target would
 * publish a `dist` tree nothing consumes. `lib` is therefore a Typecheck over
 * the package tsconfig, the same compiler run the build would perform, and it
 * keeps the conventional label so dependents and the default-target convention
 * are unchanged.
 */
import { Smithers } from "@smthrs/targets"

const cwd = "packages/build-cli"
const sources = Smithers.glob("src/**/*.ts")
const tests = Smithers.glob("test/**/*.test.ts")

export const lib = Smithers.Typecheck({
  srcs: [sources],
  deps: [],
  tsconfig: Smithers.file("tsconfig.json"),
  buildMode: false,
  incremental: false,
  cwd
})

export const check = Smithers.Typecheck({
  srcs: [sources, Smithers.glob("test/**/*.ts")],
  deps: [lib],
  tsconfig: Smithers.file("tsconfig.test.json"),
  buildMode: false,
  incremental: false,
  cwd
})

export const test = Smithers.Vitest({
  tests: [tests],
  sources: [sources],
  deps: [lib],
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
