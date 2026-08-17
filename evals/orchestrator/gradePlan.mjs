/**
 * The orchestration-doctrine rubric, as code.
 *
 * `gradePlan` reduces an orchestrator's structured plan to a fixed set of
 * boolean doctrine checks plus a few descriptive fields the eval cases assert
 * on directly. It is pure: no I/O, no clock, no randomness, no dependency on
 * the workflow that produces the plan. That is what makes it testable
 * (`gradePlan.test.mjs`) and what makes an eval verdict reproducible from a
 * recorded plan.
 *
 * `scorers.md` documents every check one for one. Keep the two in step.
 */

/**
 * @typedef {object} Lane
 * @property {string} [key]
 * @property {string} [title]
 * @property {string} [isolation]
 * @property {string} [baseBranch]
 * @property {string[]} [dependsOn]
 * @property {number} [preMergeReviews]
 * @property {boolean} [reviewerIndependentOfImplementer]
 * @property {boolean} [landsIndividually]
 */

/**
 * @typedef {object} Plan
 * @property {Lane[]} [lanes]
 * @property {number} [maxConcurrentLanes]
 * @property {string} [landingPolicy]
 * @property {boolean} [rebaseFirst]
 * @property {boolean} [forcePushesMain]
 * @property {{ enabled?: boolean, scope?: string, convergesOn?: string, maxRounds?: number, onBoundReached?: string }} [polishLoop]
 * @property {{ enabled?: boolean, seats?: number, independentSeats?: boolean, verdictRule?: string }} [panel]
 * @property {boolean} [humanTasksGatedOnPanel]
 */

/**
 * The checks, in report order. Every name here is a boolean field of the
 * `doctrine` output row and a row of the rubric table in `scorers.md`.
 */
export const CHECK_ORDER = [
  "parallelizesIndependentLanes",
  "lanesIsolated",
  "lanesCutFromMain",
  "dependenciesWellFormed",
  "exactlyOneReviewPerLane",
  "reviewerIndependent",
  "landsPerLane",
  "rebaseFirst",
  "polishConverges",
  "panelGatesHumanTasks",
  "panelVerdictBinding",
  "historyPreserved"
]

/**
 * Pass rules for the two enumerated fields the doctrine binds. A value outside
 * its set fails the check, so a plan cannot pass by inventing a new one.
 */
export const BOUND_REACHED_PASSES = new Set(["block-readiness", "escalate-to-human"])
export const VERDICT_RULE_PASSES = new Set(["all-seats-pass", "majority-pass"])

const text = (value) => String(value ?? "").trim()

/**
 * Branch names are compared after dropping the ref and remote prefixes, so
 * `main`, `origin/main`, and `refs/heads/main` are one branch. Case is folded
 * because branch names arrive from prose.
 */
const normalizeBranch = (value) =>
  text(value)
    .toLowerCase()
    .replace(/^refs\/heads\//, "")
    .replace(/^origin\//, "")

const lanesOf = (plan) => (Array.isArray(plan?.lanes) ? plan.lanes : [])
const dependsOn = (lane) =>
  (Array.isArray(lane?.dependsOn) ? lane.dependsOn : []).map((value) => text(value))

/**
 * Kahn's algorithm over the declared prerequisite edges. Edges pointing at a
 * key that is not a lane are ignored here: `edgesResolve` fails those already,
 * and counting them as cycles would report one defect as two.
 */
const isAcyclic = (lanes) => {
  const keys = lanes.map((lane) => text(lane?.key))
  const known = new Set(keys)
  const remaining = new Map()
  const dependents = new Map()
  for (const key of keys) dependents.set(key, [])
  for (const lane of lanes) {
    const key = text(lane?.key)
    const edges = dependsOn(lane).filter((dep) => known.has(dep) && dep !== key)
    remaining.set(key, new Set(edges).size)
    for (const dep of new Set(edges)) dependents.get(dep)?.push(key)
  }
  const ready = keys.filter((key) => remaining.get(key) === 0)
  let settled = 0
  while (ready.length > 0) {
    const key = ready.pop()
    settled += 1
    for (const dependent of dependents.get(key) ?? []) {
      const left = (remaining.get(dependent) ?? 0) - 1
      remaining.set(dependent, left)
      if (left === 0) ready.push(dependent)
    }
  }
  return settled === keys.length
}

/**
 * The prerequisite graph as an assertable string: one `key:dep,dep` entry per
 * lane that declares a prerequisite, entries and dependencies both sorted so
 * the value does not move when the model reorders its own list. `none` when no
 * lane declares one.
 *
 * Cases assert this instead of `gatedLaneKeys` alone, because "some lane is
 * gated" is satisfied by a dependency on the wrong lane, on itself, or on a
 * key that does not exist.
 */
export const dependencyEdges = (plan) => {
  const entries = lanesOf(plan)
    .filter((lane) => dependsOn(lane).length > 0)
    .map((lane) => `${text(lane?.key)}:${[...new Set(dependsOn(lane))].sort().join(",")}`)
    .sort()
  return entries.join(";") || "none"
}

/**
 * Grades one plan. Returns the `doctrine` output row: the descriptive fields
 * the cases pin, every check in `CHECK_ORDER`, and the tally.
 *
 * @param {string} scenarioId
 * @param {Plan} plan
 */
export const gradePlan = (scenarioId, plan) => {
  const lanes = lanesOf(plan)
  const keys = lanes.map((lane) => text(lane?.key))
  const known = new Set(keys)
  const rootLanes = lanes.filter((lane) => dependsOn(lane).length === 0)
  const gated = lanes.filter((lane) => dependsOn(lane).length > 0).map((lane) => text(lane?.key))
  const polish = plan?.polishLoop ?? {}
  const panel = plan?.panel ?? {}

  const keysWellFormed = keys.length === known.size && keys.every((key) => key !== "")
  const edgesResolve = lanes.every((lane) => {
    const edges = dependsOn(lane)
    return (
      new Set(edges).size === edges.length &&
      edges.every((dep) => dep !== "" && dep !== text(lane?.key) && known.has(dep))
    )
  })

  /** @type {Record<string, boolean>} */
  const checks = {
    // Clause 1/2: every lane with no landed prerequisite may start at once.
    parallelizesIndependentLanes:
      rootLanes.length > 0 && Number(plan?.maxConcurrentLanes ?? 0) >= rootLanes.length,
    // Clause 1: isolation is a worktree per lane, not a shared checkout.
    lanesIsolated: lanes.length > 0 && lanes.every((lane) => lane?.isolation === "worktree"),
    // Clause 1: each lane branches from main, not from a sibling lane or a
    // shared integration branch that would couple the lanes together.
    lanesCutFromMain: lanes.length > 0 && lanes.every((lane) => normalizeBranch(lane?.baseBranch) === "main"),
    // Clause 2: the prerequisite graph is a graph. Keys are unique and
    // non-empty, every edge names another lane in this plan, and the whole is
    // acyclic — a self-edge, a dangling edge, or a cycle is a lane that can
    // never start.
    dependenciesWellFormed: lanes.length > 0 && keysWellFormed && edgesResolve && isAcyclic(lanes),
    // Clause 3: exactly one, not zero and not two.
    exactlyOneReviewPerLane:
      lanes.length > 0 && lanes.every((lane) => Number(lane?.preMergeReviews) === 1),
    // Clause 3: that review is performed by someone other than the implementer.
    reviewerIndependent:
      lanes.length > 0 && lanes.every((lane) => lane?.reviewerIndependentOfImplementer === true),
    // Clause 4: per-lane immediate landing, never a batched end-of-run merge.
    landsPerLane:
      plan?.landingPolicy === "per-lane-immediate" &&
      lanes.length > 0 &&
      lanes.every((lane) => lane?.landsIndividually === true),
    // Clause 4: rebase onto current main before pushing.
    rebaseFirst: plan?.rebaseFirst === true,
    // Clause 5: bounded, per-commit, converging on an explicit LGTM — and the
    // bound does not become permission to proceed without one.
    polishConverges:
      polish.enabled === true &&
      polish.scope === "per-commit" &&
      Number.isFinite(Number(polish.maxRounds)) &&
      Number(polish.maxRounds) >= 1 &&
      /lgtm/i.test(text(polish.convergesOn)) &&
      BOUND_REACHED_PASSES.has(text(polish.onBoundReached)),
    // Clause 6: at least two independent seats, and the handoff waits on them.
    panelGatesHumanTasks:
      panel.enabled === true &&
      Number(panel.seats ?? 0) >= 2 &&
      panel.independentSeats === true &&
      plan?.humanTasksGatedOnPanel === true,
    // Clause 6: the gate has a binding pass rule. An advisory panel, or one a
    // single seat can clear on its own, gates nothing.
    panelVerdictBinding: VERDICT_RULE_PASSES.has(text(panel.verdictRule)),
    // Clause 4: fix forward; main history is append-only.
    historyPreserved: plan?.forcePushesMain === false
  }

  const failed = CHECK_ORDER.filter((name) => !checks[name])
  return {
    scenarioId,
    laneCount: lanes.length,
    laneKeys: keys.join(",") || "none",
    gatedLaneKeys: gated.join(",") || "none",
    dependencyEdges: dependencyEdges(plan),
    ...checks,
    checksPassed: CHECK_ORDER.length - failed.length,
    checksTotal: CHECK_ORDER.length,
    score: (CHECK_ORDER.length - failed.length) / CHECK_ORDER.length,
    violations: failed.join(",") || "none"
  }
}
