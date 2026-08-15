/**
 * Standard package targets plus cross-package and dependency-policy edges.
 *
 * These targets are executable: the engine's `lib` depends on the flow
 * package's `lib`, so the dependency runs first and contributes its content
 * key. `dependencyPolicy` adds the package's explicit knip check.
 */
import { DepsLint, file, glob, StandardPackage } from "tsflows-rules"
import { lib as flow } from "../flow/BUILD.ts"

const standard = StandardPackage({ deps: [flow], cwd: "packages/engine" })

export const lib = standard.lib
export const check = standard.check
export const test = standard.test
export const lint = standard.lint
export const fmt = standard.fmt
export const docs = standard.docs

export const dependencyPolicy = DepsLint({
  packageJson: file("package.json"),
  sources: [glob("src/**/*.ts"), glob("test/**/*.ts")],
  deps: [lib],
  tool: "knip",
  ignoreDependencies: ["@effect/platform-node"],
  ignoreBinaries: []
})
