/**
 * Standard package targets plus a cross-package dependency edge.
 *
 * These targets are executable: the engine's `lib` depends on the flow
 * package's `lib`, so `tsflows build //packages/engine:lib` schedules the
 * dependency first and folds its content key into this package's key.
 */
import { StandardPackage } from "tsflows-rules"
import { lib as flow } from "../flow/BUILD.ts"

const standard = StandardPackage({ cwd: "packages/engine", deps: [flow] })

export const lib = standard.lib
export const test = standard.test
export const lint = standard.lint
export const docs = standard.docs
