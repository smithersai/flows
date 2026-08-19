/**
 * Standard package targets in the bare `StandardPackage` form.
 *
 * `cwd` anchors every emitted tool run in this package directory.
 */
import { Smithers } from "@smthrs/targets"

export const { check, docs, fmt, lib, lint, test } = Smithers.StandardPackage({
  deps: [],
  cwd: "packages/plan"
})
