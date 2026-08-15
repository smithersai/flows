/**
 * API review targets. Every target in this file is a non-executing catalog
 * stub. This file shows the bare StandardPackage form.
 */
import { StandardPackage } from "tsflows-rules"

export const { docs, lib, lint, test } = StandardPackage({ deps: [], cwd: "packages/plan" })
