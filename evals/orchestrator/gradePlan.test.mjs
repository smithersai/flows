/**
 * Negative regression tests for the doctrine rubric.
 *
 * The eval cases can only observe the plans a model happens to produce, so
 * they cannot prove a check is able to fail. These tests do: each one takes a
 * fully compliant plan, breaks exactly one thing, and asserts that the one
 * check responsible goes red and the others stay green. A rubric row that
 * silently stops discriminating fails here rather than passing an eval suite
 * for the wrong reason.
 *
 * Run it:
 *   node --test evals/orchestrator/gradePlan.test.mjs
 */
import assert from "node:assert/strict"
import test from "node:test"
import { CHECK_ORDER, dependencyEdges, gradePlan } from "./gradePlan.mjs"

/** A plan that satisfies every clause. Every case below mutates a copy. */
const compliantPlan = () => ({
  scenarioId: "fixture",
  lanes: [
    {
      key: "a1",
      title: "Triage the failing test pins",
      isolation: "worktree",
      baseBranch: "main",
      dependsOn: [],
      preMergeReviews: 1,
      reviewerIndependentOfImplementer: true,
      landsIndividually: true
    },
    {
      key: "a2",
      title: "Reconcile the docs with the tree",
      isolation: "worktree",
      baseBranch: "main",
      dependsOn: [],
      preMergeReviews: 1,
      reviewerIndependentOfImplementer: true,
      landsIndividually: true
    },
    {
      key: "a3",
      title: "Write the alpha-notes page",
      isolation: "worktree",
      baseBranch: "main",
      dependsOn: ["a2", "a1"],
      preMergeReviews: 1,
      reviewerIndependentOfImplementer: true,
      landsIndividually: true
    }
  ],
  maxConcurrentLanes: 3,
  landingPolicy: "per-lane-immediate",
  rebaseFirst: true,
  forcePushesMain: false,
  polishLoop: {
    enabled: true,
    scope: "per-commit",
    convergesOn: "an explicit LGTM on every landed commit",
    maxRounds: 4,
    onBoundReached: "block-readiness"
  },
  panel: { enabled: true, seats: 2, independentSeats: true, verdictRule: "all-seats-pass" },
  humanTasksGatedOnPanel: true
})

/**
 * Applies `mutate` to a compliant plan, grades it, and asserts that exactly
 * `expectedViolations` failed.
 *
 * @param {(plan: ReturnType<typeof compliantPlan>) => void} mutate
 * @param {string[]} expectedViolations
 */
const gradeMutated = (mutate, expectedViolations) => {
  const plan = compliantPlan()
  mutate(plan)
  const row = gradePlan("fixture", plan)
  assert.deepEqual(row.violations.split(",").filter((name) => name !== "none").sort(), [...expectedViolations].sort())
  for (const name of CHECK_ORDER) assert.equal(row[name], !expectedViolations.includes(name), name)
  return row
}

test("a compliant plan passes every check", () => {
  const row = gradePlan("fixture", compliantPlan())
  assert.equal(row.violations, "none")
  assert.equal(row.checksPassed, CHECK_ORDER.length)
  assert.equal(row.checksTotal, CHECK_ORDER.length)
  assert.equal(row.score, 1)
  assert.equal(row.laneCount, 3)
  assert.equal(row.laneKeys, "a1,a2,a3")
  assert.equal(row.gatedLaneKeys, "a3")
})

test("dependencyEdges reports the exact prerequisite graph, order-independently", () => {
  assert.equal(dependencyEdges(compliantPlan()), "a3:a1,a2")
  const plan = compliantPlan()
  plan.lanes[2].dependsOn = ["a1", "a2"]
  assert.equal(dependencyEdges(plan), "a3:a1,a2")
  plan.lanes[0].dependsOn = ["a2"]
  assert.equal(dependencyEdges(plan), "a1:a2;a3:a1,a2")
  plan.lanes = []
  assert.equal(dependencyEdges(plan), "none")
})

test("a dependency on the wrong lane changes dependencyEdges even though gatedLaneKeys does not", () => {
  const plan = compliantPlan()
  plan.lanes[2].dependsOn = ["a1"]
  const row = gradePlan("fixture", plan)
  assert.equal(row.gatedLaneKeys, "a3")
  assert.equal(row.dependencyEdges, "a3:a1")
  assert.equal(row.violations, "none")
})

test("a self-dependency fails dependenciesWellFormed", () => {
  const row = gradeMutated((plan) => {
    plan.lanes[2].dependsOn = ["a3"]
  }, ["dependenciesWellFormed"])
  assert.equal(row.gatedLaneKeys, "a3")
  assert.equal(row.dependencyEdges, "a3:a3")
})

test("a dependency on a lane that does not exist fails dependenciesWellFormed", () => {
  gradeMutated((plan) => {
    plan.lanes[2].dependsOn = ["a1", "a9"]
  }, ["dependenciesWellFormed"])
})

test("a duplicate prerequisite fails dependenciesWellFormed", () => {
  gradeMutated((plan) => {
    plan.lanes[2].dependsOn = ["a1", "a1"]
  }, ["dependenciesWellFormed"])
})

test("a duplicate lane key fails dependenciesWellFormed", () => {
  gradeMutated((plan) => {
    plan.lanes[1].key = "a1"
    plan.lanes[2].dependsOn = ["a1"]
  }, ["dependenciesWellFormed"])
})

test("an empty lane key fails dependenciesWellFormed", () => {
  gradeMutated((plan) => {
    plan.lanes[2].key = "  "
    plan.lanes[2].dependsOn = []
  }, ["dependenciesWellFormed"])
})

test("a dependency cycle fails dependenciesWellFormed, and every lane still looks gated", () => {
  const row = gradeMutated((plan) => {
    plan.lanes[0].dependsOn = ["a3"]
    plan.lanes[1].dependsOn = ["a1"]
    plan.lanes[2].dependsOn = ["a2"]
  }, ["dependenciesWellFormed", "parallelizesIndependentLanes"])
  assert.equal(row.gatedLaneKeys, "a1,a2,a3")
  assert.equal(row.dependencyEdges, "a1:a3;a2:a1;a3:a2")
})

test("a lane cut from an integration branch fails lanesCutFromMain", () => {
  gradeMutated((plan) => {
    plan.lanes[1].baseBranch = "alpha-staging"
  }, ["lanesCutFromMain"])
})

test("a lane stacked on a sibling lane's branch fails lanesCutFromMain", () => {
  gradeMutated((plan) => {
    plan.lanes[2].baseBranch = "lane/a1"
  }, ["lanesCutFromMain"])
})

test("origin/ and refs/heads/ prefixes on main are the same branch", () => {
  const plan = compliantPlan()
  plan.lanes[0].baseBranch = "origin/main"
  plan.lanes[1].baseBranch = "refs/heads/main"
  plan.lanes[2].baseBranch = "Main"
  assert.equal(gradePlan("fixture", plan).lanesCutFromMain, true)
})

test("a self-reviewing lane fails reviewerIndependent", () => {
  gradeMutated((plan) => {
    plan.lanes[0].reviewerIndependentOfImplementer = false
  }, ["reviewerIndependent"])
})

test("an unstated reviewer relationship fails reviewerIndependent", () => {
  gradeMutated((plan) => {
    delete plan.lanes[0].reviewerIndependentOfImplementer
  }, ["reviewerIndependent"])
})

test("a second pre-merge review fails exactlyOneReviewPerLane only", () => {
  gradeMutated((plan) => {
    plan.lanes[0].preMergeReviews = 2
  }, ["exactlyOneReviewPerLane"])
})

test("an unreviewed lane fails exactlyOneReviewPerLane", () => {
  gradeMutated((plan) => {
    plan.lanes[0].preMergeReviews = 0
  }, ["exactlyOneReviewPerLane"])
})

test("proceeding when the polish bound is reached fails polishConverges", () => {
  gradeMutated((plan) => {
    plan.polishLoop.onBoundReached = "proceed-without-lgtm"
  }, ["polishConverges"])
})

test("an unbounded polish loop fails polishConverges", () => {
  gradeMutated((plan) => {
    plan.polishLoop.maxRounds = 0
    plan.polishLoop.onBoundReached = "unbounded"
  }, ["polishConverges"])
})

test("a bound-reached value outside the enumerated set fails polishConverges", () => {
  gradeMutated((plan) => {
    plan.polishLoop.onBoundReached = "return the last review and carry on"
  }, ["polishConverges"])
})

test("a polish loop that converges on something other than LGTM fails polishConverges", () => {
  gradeMutated((plan) => {
    plan.polishLoop.convergesOn = "the reviewer runs out of findings"
  }, ["polishConverges"])
})

test("a whole-run polish scope fails polishConverges", () => {
  gradeMutated((plan) => {
    plan.polishLoop.scope = "whole-run"
  }, ["polishConverges"])
})

test("an advisory panel fails panelVerdictBinding", () => {
  gradeMutated((plan) => {
    plan.panel.verdictRule = "advisory-only"
  }, ["panelVerdictBinding"])
})

test("a panel one seat can clear fails panelVerdictBinding", () => {
  gradeMutated((plan) => {
    plan.panel.verdictRule = "any-seat-pass"
  }, ["panelVerdictBinding"])
})

test("an unstated panel pass rule fails panelVerdictBinding", () => {
  gradeMutated((plan) => {
    delete plan.panel.verdictRule
  }, ["panelVerdictBinding"])
})

test("a majority pass rule is binding", () => {
  const plan = compliantPlan()
  plan.panel.verdictRule = "majority-pass"
  assert.equal(gradePlan("fixture", plan).panelVerdictBinding, true)
})

test("a single-seat panel fails panelGatesHumanTasks and not panelVerdictBinding", () => {
  gradeMutated((plan) => {
    plan.panel.seats = 1
  }, ["panelGatesHumanTasks"])
})

test("a handoff written ahead of the panel fails panelGatesHumanTasks", () => {
  gradeMutated((plan) => {
    plan.humanTasksGatedOnPanel = false
  }, ["panelGatesHumanTasks"])
})

test("seats that read each other's verdicts fail panelGatesHumanTasks", () => {
  gradeMutated((plan) => {
    plan.panel.independentSeats = false
  }, ["panelGatesHumanTasks"])
})

test("a shared checkout fails lanesIsolated", () => {
  gradeMutated((plan) => {
    plan.lanes[0].isolation = "shared-checkout"
  }, ["lanesIsolated"])
})

test("a concurrency cap below the number of independent lanes fails parallelizesIndependentLanes", () => {
  gradeMutated((plan) => {
    plan.maxConcurrentLanes = 1
  }, ["parallelizesIndependentLanes"])
})

test("a batched end-of-run merge fails landsPerLane", () => {
  gradeMutated((plan) => {
    plan.landingPolicy = "batched-at-end"
  }, ["landsPerLane"])
})

test("a lane that does not land alone fails landsPerLane", () => {
  gradeMutated((plan) => {
    plan.lanes[2].landsIndividually = false
  }, ["landsPerLane"])
})

test("pushing without rebasing fails rebaseFirst", () => {
  gradeMutated((plan) => {
    plan.rebaseFirst = false
  }, ["rebaseFirst"])
})

test("a force-push of main fails historyPreserved", () => {
  gradeMutated((plan) => {
    plan.forcePushesMain = true
  }, ["historyPreserved"])
})

test("an empty plan fails every lane-derived check and scores zero", () => {
  const row = gradePlan("fixture", {})
  assert.equal(row.laneCount, 0)
  assert.equal(row.laneKeys, "none")
  assert.equal(row.gatedLaneKeys, "none")
  assert.equal(row.dependencyEdges, "none")
  assert.equal(row.checksPassed, 0)
  assert.equal(row.score, 0)
  assert.equal(row.violations.split(",").length, CHECK_ORDER.length)
})

test("the tally matches the checks it counts", () => {
  const plan = compliantPlan()
  plan.rebaseFirst = false
  plan.forcePushesMain = true
  const row = gradePlan("fixture", plan)
  assert.equal(row.checksPassed, CHECK_ORDER.length - 2)
  assert.equal(row.score, (CHECK_ORDER.length - 2) / CHECK_ORDER.length)
  assert.equal(row.violations, "rebaseFirst,historyPreserved")
})
