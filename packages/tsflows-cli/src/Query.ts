/**
 * BUILD target queries.
 *
 * @since 0.1.0
 */
import { Rule } from "tsflows-rules"
import * as Planner from "./Planner.ts"
import type * as Workspace from "./Workspace.ts"

/**
 * Result of a bare label or pattern query.
 *
 * @category models
 * @since 0.1.0
 */
export interface Listing {
  readonly query: string
  readonly targets: ReadonlyArray<{
    readonly label: string
    readonly rule: string
    readonly kinds: ReadonlyArray<Rule.Kind>
  }>
}

/**
 * Result of a `deps(label)` query.
 *
 * @category models
 * @since 0.1.0
 */
export interface Dependencies {
  readonly query: string
  readonly root: string
  readonly dependencies: ReadonlyArray<string>
  readonly edges: ReadonlyArray<Planner.Edge>
}

/**
 * Evaluates a bare label/pattern listing or `deps(label)`.
 *
 * @category querying
 * @since 0.1.0
 */
export const run = async (
  workspace: Workspace.Workspace,
  expression: string
): Promise<Listing | Dependencies> => {
  const dependencyMatch = expression.match(/^deps\((.+)\)$/)
  if (dependencyMatch?.[1] !== undefined) {
    const pattern = dependencyMatch[1].trim()
    const plan = await Planner.make(workspace, "query", pattern)
    if (plan.roots.length !== 1) throw new Error("deps() requires one exact or default target")
    const root = plan.roots[0]!
    return {
      query: expression,
      root,
      dependencies: plan.targets.map((target) => target.label).filter((label) => label !== root),
      edges: plan.edges
    }
  }
  const targets = await workspace.targets(expression)
  return {
    query: expression,
    targets: await Promise.all(targets.map(async (target) => ({
      label: await workspace.label(target),
      rule: Rule.metadata(target).rule,
      kinds: Rule.metadata(target).kinds
    })))
  }
}
