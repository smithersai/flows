/**
 * API review targets. Every target in this file is a non-executing catalog
 * stub. This file shows the bare StandardPackage form.
 */
import { StandardPackage } from "../../../tsflows/rules/src/index.ts"

export const { lib, test, lint } = StandardPackage({ deps: [] })
