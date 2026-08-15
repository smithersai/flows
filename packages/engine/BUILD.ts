/**
 * API review targets. Every target in this file is a non-executing catalog
 * stub. This file shows StandardPackage plus an adjusted extra target.
 */
import { DepsLint, file, glob, StandardPackage } from "tsflows-rules"
import { lib as flow } from "../flow/BUILD.ts"

const standard = StandardPackage({ deps: [flow], cwd: "packages/engine" })

export const lib = standard.lib
export const test = standard.test
export const lint = standard.lint
export const docs = standard.docs

export const dependencyPolicy = DepsLint({
  packageJson: file("package.json"),
  sources: [glob("src/**/*.ts"), glob("test/**/*.ts")],
  deps: [lib],
  tool: "knip",
  ignoreDependencies: ["@effect/platform-node"],
  ignoreBinaries: []
})
