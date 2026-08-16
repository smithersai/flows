/** @jsxImportSource react */
// Graph-shape tests for the alpha-agent workflow. Renders the REAL workflow
// module through renderWorkflow and asserts node ids, sequence order, output
// schemas, and the conditional expansions that drive the phase machine.
// @ts-expect-error bun:test types are provided by the bun runtime, not @types/node
import { describe, expect, test } from "bun:test"
import { renderWorkflow } from "smthrs/testing"
import workflow from "../workflows/alpha-agent.tsx"

const LANE_KEYS = ["a1", "a2", "a3", "a4", "a5", "a6", "a7"] as const

const render = (outputs: Record<string, unknown[]> = {}) =>
  renderWorkflow(workflow, { input: { carriedFindings: "" }, outputs })

type RenderedTasks = { tasks: readonly { nodeId: string }[] }
const ids = (g: RenderedTasks) => g.tasks.map((t) => t.nodeId)
const pick = (g: RenderedTasks, id: string) =>
  g.tasks.find((t) => t.nodeId === id) as any

const landedRow = (k: string) => ({
  nodeId: `${k}Land`,
  iteration: 0,
  laneKey: k,
  landed: true,
  landedShas: "abc1234",
  gatesRun: "pnpm run check green",
  gatesGreen: true,
  notes: "clean",
})

const panelRow = (verifier: "codex" | "fable", verdict: "PRODUCTION-READY" | "NOT-READY") => ({
  nodeId: verifier === "codex" ? "panelCodex" : "panelFable",
  iteration: 0,
  verifier,
  verdict,
  findings: verdict === "PRODUCTION-READY" ? "none" : "1. A2 docs page missing",
  evidence: "ran the DoD evidence commands and recorded the observed results",
})

describe("alpha-agent workflow graph", () => {
  test("phase 1 renders all lanes, evals, panel, and the escalate gate only", async () => {
    const g = await render()
    const nodeIds = ids(g)
    for (const k of LANE_KEYS) {
      expect(nodeIds).toContain(`${k}Impl`)
      expect(nodeIds).toContain(`${k}Review`)
      expect(nodeIds).not.toContain(`${k}Land`)
      expect(nodeIds).not.toContain(`${k}PolishReview`)
    }
    expect(nodeIds).toContain("evalsAuthor")
    expect(nodeIds).toContain("panelCodex")
    expect(nodeIds).toContain("panelFable")
    expect(nodeIds).toContain("humanEscalate")
    expect(nodeIds).not.toContain("evalsLand")
    expect(nodeIds).not.toContain("panelRemediate")
    expect(nodeIds).not.toContain("humanPrep")
    expect(nodeIds).not.toContain("humanRatify")
  })

  test("each lane sequences impl before review inside its own worktree", async () => {
    const g = await render()
    for (const k of LANE_KEYS) {
      const impl = pick(g, `${k}Impl`)
      const review = pick(g, `${k}Review`)
      expect(impl.ordinal).toBeLessThan(review.ordinal)
      expect(impl.worktreeId).toBe(`${k}Wt`)
      expect(review.worktreeId).toBe(`${k}Wt`)
      expect(impl.worktreeBranch).toBe(`alpha/${k}`)
      expect(impl.worktreePath).toBe(`/Users/williamcory/flows1/.smithers/workflows/.worktrees/alpha-${k}`)
    }
  })

  test("output schemas resolve and enforce required content", async () => {
    const g = await render()
    const impl = pick(g, "a1Impl")
    expect(impl.outputTableName).toBe("alphaImpl")
    expect(
      impl.outputSchema.safeParse({
        laneKey: "a1",
        summary: "shipped the production ControlExecutor with the CellHarness body wired",
        alreadyLandedOnMain: false,
        commitsOnBranch: "abc1234 feat",
        gatesRun: "pnpm run check; pnpm test",
        gatesGreen: true,
        blocked: "none",
      }).success,
    ).toBe(true)
    expect(impl.outputSchema.safeParse({}).success).toBe(false)
    const review = pick(g, "a1Review")
    expect(review.outputTableName).toBe("alphaReview")
    expect(review.outputSchema.safeParse({ laneKey: "a1", verdict: "SHIP", findings: "x", dodAssessment: "y".repeat(30) }).success).toBe(false)
    const human = pick(g, "humanEscalate")
    expect(human.kind).toBe("human")
    expect(human.needsApproval).toBe(true)
  })

  test("a review row mounts that lane's land task in the serialized merge queue", async () => {
    const g = await render({
      alphaReview: [
        {
          nodeId: "a1Review",
          iteration: 0,
          laneKey: "a1",
          verdict: "FIX",
          findings: "1. add the steer round-trip assertion",
          dodAssessment: "integration test missing the steer leg",
        },
      ],
    })
    const nodeIds = ids(g)
    expect(nodeIds).toContain("a1Land")
    expect(nodeIds).not.toContain("a2Land")
    const land = pick(g, "a1Land")
    expect(land.parallelGroupId).toBe("alphaMergeQueue")
    expect(land.parallelMaxConcurrency).toBe(1)
    expect(String(land.prompt)).toContain("1. add the steer round-trip assertion")
  })

  test("a landed lane mounts its polish loop; FIX verdicts mount the fix task", async () => {
    const landedOnly = await render({ alphaLand: [landedRow("a1")] })
    expect(ids(landedOnly)).toContain("a1PolishReview")
    expect(ids(landedOnly)).not.toContain("a1PolishFix")
    expect(ids(landedOnly)).not.toContain("a2PolishReview")

    const withFix = await render({
      alphaLand: [landedRow("a1")],
      alphaPolish: [
        { nodeId: "a1PolishReview", iteration: 0, laneKey: "a1", verdict: "FIX", ciStatus: "green", findings: "1. tighten the ceiling test" },
      ],
    })
    expect(ids(withFix)).toContain("a1PolishFix")
    expect(String(pick(withFix, "a1PolishFix").prompt)).toContain("1. tighten the ceiling test")

    const withLgtm = await render({
      alphaLand: [landedRow("a1")],
      alphaPolish: [
        { nodeId: "a1PolishReview", iteration: 0, laneKey: "a1", verdict: "LGTM", ciStatus: "green", findings: "none" },
      ],
    })
    expect(ids(withLgtm)).not.toContain("a1PolishFix")
  })

  test("a failed panel mounts remediation; a passed panel unlocks the human gate", async () => {
    const failed = await render({ alphaPanel: [panelRow("codex", "NOT-READY"), panelRow("fable", "PRODUCTION-READY")] })
    expect(ids(failed)).toContain("panelRemediate")
    expect(ids(failed)).toContain("humanEscalate")
    expect(ids(failed)).not.toContain("humanRatify")
    expect(String(pick(failed, "panelRemediate").prompt)).toContain("1. A2 docs page missing")

    const passed = await render({ alphaPanel: [panelRow("codex", "PRODUCTION-READY"), panelRow("fable", "PRODUCTION-READY")] })
    const passedIds = ids(passed)
    expect(passedIds).toContain("humanPrep")
    expect(passedIds).toContain("humanRatify")
    expect(passedIds).not.toContain("humanEscalate")
    expect(passedIds).not.toContain("panelRemediate")
    const prep = pick(passed, "humanPrep")
    const ratify = pick(passed, "humanRatify")
    expect(prep.ordinal).toBeLessThan(ratify.ordinal)
  })
})
