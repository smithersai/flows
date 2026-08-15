/**
 * Standard package targets in the bare `StandardPackage` form.
 *
 * These targets are executable: `tsflows ci //packages/plan:lib` (or the
 * per-verb labels `:test`, `:lint`, `:docs`) runs them through the flows
 * engine. `cwd` anchors every emitted tool run in this package directory.
 */
import { StandardPackage } from "tsflows-rules"

export const { docs, lib, lint, test } = StandardPackage({ cwd: "packages/plan" })
