/**
 * API review targets. Every target in this file is a non-executing catalog
 * stub. This file shows StandardPackage desugared into three rule calls.
 */
import {
  EsLint,
  TsBuild,
  Vitest,
  file,
  glob
} from "../../../tsflows/rules/src/index.ts"
import { rootJSDocConfig } from "../../BUILD.ts"
import { lib as plan } from "../plan/BUILD.ts"

const sources = glob("src/**/*.ts")
const tests = glob("test/**/*.test.ts")

export const lib = TsBuild({
  srcs: [sources],
  entries: ["src/index.ts"],
  deps: [plan],
  tsconfig: file("tsconfig.json"),
  tool: "tsc",
  format: "dual",
  outDir: "dist",
  external: []
})

export const test = Vitest({
  tests: [tests],
  sources: [sources],
  deps: [lib, plan],
  config: file("vitest.config.ts"),
  environment: "node",
  passWithNoTests: false
})

export const lint = EsLint({
  sources: [sources, tests],
  deps: [],
  configs: [file("eslint.config.js"), rootJSDocConfig],
  maxWarnings: 0,
  fix: false
})
