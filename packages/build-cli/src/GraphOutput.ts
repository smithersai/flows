/**
 * Human-readable target graph renderers.
 *
 * @since 0.1.0
 */
import type * as Planner from "./Planner.ts"

const targetMap = (plan: Planner.Plan): ReadonlyMap<string, Planner.PlannedTarget> =>
  new Map(plan.targets.map((target) => [target.label, target]))

const treeLines = (
  label: string,
  targets: ReadonlyMap<string, Planner.PlannedTarget>,
  prefix: string,
  last: boolean,
  seen: Set<string>,
  root: boolean = false
): ReadonlyArray<string> => {
  const target = targets.get(label)
  const marker = root ? "" : last ? "└─ " : "├─ "
  if (target === undefined) return [`${prefix}${marker}${label} [external]`]
  const repeated = seen.has(label)
  const line = `${prefix}${marker}${label} (${target.target})${repeated ? " [seen]" : ""}`
  if (repeated) return [line]
  seen.add(label)
  const childPrefix = root ? "" : `${prefix}${last ? "   " : "│  "}`
  return [
    line,
    ...target.dependencies.flatMap((dependency, index) =>
      treeLines(dependency, targets, childPrefix, index === target.dependencies.length - 1, seen)
    )
  ]
}

/**
 * Renders root-to-dependency text trees.
 *
 * @category formatting
 * @since 0.1.0
 * @slop
 */
export const text = (plan: Planner.Plan): string => {
  const targets = targetMap(plan)
  return plan.roots
    .flatMap((root, index) => [
      ...(index === 0 ? [] : [""]),
      ...treeLines(root, targets, "", true, new Set(), true)
    ])
    .join("\n")
}

const mermaidId = (label: string): string => `n_${Buffer.from(label).toString("hex")}`
const mermaidLabel = (label: string): string => label.replaceAll("\"", "&quot;")

/**
 * Renders a Mermaid target graph.
 *
 * @category formatting
 * @since 0.1.0
 * @slop
 */
export const mermaid = (plan: Planner.Plan): string => {
  const lines = ["flowchart LR"]
  for (const target of plan.targets) {
    lines.push(`  ${mermaidId(target.label)}["${mermaidLabel(`${target.label}\\n${target.target}`)}"]`)
  }
  for (const edge of plan.edges) lines.push(`  ${mermaidId(edge.from)} --> ${mermaidId(edge.to)}`)
  return lines.join("\n")
}
