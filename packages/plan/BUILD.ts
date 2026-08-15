/**
 * Standard package targets in the bare `StandardPackage` form.
 *
 * `cwd` anchors every emitted tool run in this package directory.
 */
import { StandardPackage } from "tsflows-rules"

export const { check, docs, fmt, lib, lint, test } = StandardPackage({ deps: [], cwd: "packages/plan" })
