/** @jsxImportSource react */
// Graph-shape tests for the alpha-agent eval judge. Renders the REAL workflow
// module through renderWorkflow and asserts the node ids, ordering, output
// schemas, and the conditional that skips the model call when a case payload
// does not parse. The deterministic scorer that backs the suite's ground truth
// is unit-tested here too, against the committed fixtures.
// @ts-expect-error bun:test types are provided by the bun runtime, not @types/node
import { describe, expect, test } from "bun:test"
import { renderWorkflow } from "smthrs/testing"
import source from "../evals/alpha-agent/cases.source.json" with { type: "json" }
import { AXES, maxConcurrent, parsePayload, scoreTrace, unscorable } from "../evals/alpha-agent/scoreTrace.ts"
import workflow from "../workflows/alpha-agent-eval-judge.tsx"

type RenderedTasks = { tasks: readonly { nodeId: string }[] }
const ids = (g: RenderedTasks) => g.tasks.map((t) => t.nodeId)
const pick = (g: RenderedTasks, id: string) => g.tasks.find((t) => t.nodeId === id) as any

const payloadOf = (caseId: string) => {
  const found = (source as any[]).find((c) => c.id === caseId)
  if (!found) throw new Error(`unknown fixture ${caseId}`)
  return JSON.stringify({ caseId: found.id, trace: found.trace })
}

const render = (carriedFindings: string, outputs: Record<string, unknown[]> = {}) =>
  renderWorkflow(workflow, { input: { carriedFindings }, outputs })

const checksRow = (caseId: string, overrides: Record<string, unknown> = {}) => ({
  nodeId: "deterministicChecks",
  iteration: 0,
  caseId,
  parallelism: "PASS",
  singleReview: "PASS",
  immediateLanding: "PASS",
  polishConvergence: "PASS",
  humanGating: "PASS",
  overall: "PASS",
  violations: "none",
  stats: "{}",
  ...overrides,
})

const rubricRow = (caseId: string, overrides: Record<string, unknown> = {}) => ({
  nodeId: "rubricJudge",
  iteration: 0,
  caseId,
  parallelism: "PASS",
  singleReview: "PASS",
  immediateLanding: "PASS",
  polishConvergence: "PASS",
  humanGating: "PASS",
  score: 0.9,
  reasoning: "every axis in the trace follows the doctrine",
  ...overrides,
})

/** The reconcile step is deps-gated, so it only mounts once both rows exist. */
const renderReconciled = (
  caseId: string,
  checks: Record<string, unknown> = {},
  rubric: Record<string, unknown> = {},
) =>
  render(payloadOf(caseId), {
    alphaEvalJudgeChecks: [checksRow(caseId, checks)],
    alphaEvalJudgeRubric: [rubricRow(caseId, rubric)],
  })

describe("alpha-agent-eval-judge workflow graph", () => {
  test("a parsable case renders checks then the rubric judge, and defers reconcile", async () => {
    const g = await render(payloadOf("golden-full-run"))
    expect(ids(g)).toEqual(["deterministicChecks", "rubricJudge"])
    const checks = pick(g, "deterministicChecks")
    const rubric = pick(g, "rubricJudge")
    expect(checks.ordinal).toBeLessThan(rubric.ordinal)
    expect(checks.outputTableName).toBe("alphaEvalJudgeChecks")
    expect(rubric.outputTableName).toBe("alphaEvalJudgeRubric")
  })

  test("reconcile mounts once both upstream rows land, and lands last", async () => {
    const g = await renderReconciled("golden-full-run")
    expect(ids(g)).toEqual(["deterministicChecks", "rubricJudge", "reconcile"])
    const reconcile = pick(g, "reconcile")
    expect(reconcile.outputTableName).toBe("alphaEvalJudgeVerdict")
    expect(reconcile.ordinal).toBeGreaterThan(pick(g, "rubricJudge").ordinal)
    expect(reconcile.needs ?? reconcile.dependsOn).toBeDefined()
  })

  test("only the rubric step uses a model, and it is the cheap tier", async () => {
    const g = await renderReconciled("golden-full-run")
    expect(pick(g, "deterministicChecks").agent).toBeUndefined()
    expect(pick(g, "deterministicChecks").kind).toBe("compute")
    expect(pick(g, "reconcile").agent).toBeUndefined()
    expect(pick(g, "reconcile").kind).toBe("compute")
    const rubric = pick(g, "rubricJudge")
    expect(rubric.agent).toBeDefined()
    expect(JSON.stringify(rubric.agent)).toContain("claude-sonnet-5")
  })

  test("the judge prompt carries the trace and forbids touching the repo", async () => {
    const prompt = String(pick(await render(payloadOf("batched-landing")), "rubricJudge").prompt)
    expect(prompt).toContain("CASE ID: batched-landing")
    expect(prompt).toContain("held until every lane was green")
    expect(prompt).toContain("read the repository, or launch other agents")
    for (const axis of AXES) expect(prompt).toContain(axis)
  })

  test("an unparsable payload records N/A and never mounts the model call", async () => {
    for (const bad of ["", "not json at all", '{"trace":{}}']) {
      const g = await render(bad)
      expect(ids(g)).toEqual(["deterministicChecks"])
      expect(ids(g)).not.toContain("rubricJudge")
      expect(ids(g)).not.toContain("reconcile")
    }
  })

  test("output schemas resolve and reject rows outside the verdict vocabulary", async () => {
    const g = await renderReconciled("golden-full-run")
    expect(pick(g, "deterministicChecks").outputSchema.safeParse(checksRow("golden-full-run")).success).toBe(true)
    expect(
      pick(g, "deterministicChecks").outputSchema.safeParse(checksRow("x", { overall: "MAYBE" })).success,
    ).toBe(false)
    const verdict = pick(g, "reconcile").outputSchema
    expect(
      verdict.safeParse({
        caseId: "golden-full-run",
        parallelism: "PASS",
        singleReview: "PASS",
        immediateLanding: "PASS",
        polishConvergence: "PASS",
        humanGating: "PASS",
        overall: "PASS",
        rubricScore: 0.9,
        agreement: true,
        disagreements: "none",
        summary: "golden-full-run: all decided axes hold.",
      }).success,
    ).toBe(true)
    expect(verdict.safeParse({ caseId: "x", rubricScore: 4 }).success).toBe(false)
  })

  test("reconcile keeps the deterministic verdicts and scores judge agreement", async () => {
    // The task body closes over the deps resolved at render time, so the rows
    // passed to renderReconciled are the ones it reconciles.
    const disagreeing = await renderReconciled(
      "batched-landing",
      { immediateLanding: "FAIL", overall: "FAIL", violations: "immediateLanding: lane a1 waited 140min" },
      { immediateLanding: "FAIL", humanGating: "N/A", score: 0.4 },
    )
    const row = await pick(disagreeing, "reconcile").computeFn()
    expect(row.overall).toBe("FAIL")
    expect(row.immediateLanding).toBe("FAIL")
    expect(row.rubricScore).toBe(0.4)
    expect(row.agreement).toBe(false)
    expect(row.disagreements).toContain("humanGating")
    expect(row.summary).toContain("immediateLanding")

    const agreeing = await renderReconciled(
      "batched-landing",
      { immediateLanding: "FAIL", overall: "FAIL", violations: "immediateLanding: lane a1 waited 140min" },
      { immediateLanding: "FAIL", score: 0.4 },
    )
    const agreed = await pick(agreeing, "reconcile").computeFn()
    expect(agreed.agreement).toBe(true)
    expect(agreed.disagreements).toBe("none")
    expect(agreed.overall).toBe("FAIL")
  })

  test("an N/A axis in the checks never counts as judge disagreement", async () => {
    const g = await renderReconciled("two-lane-partial-overlap", { humanGating: "N/A" }, { humanGating: "FAIL" })
    const row = await pick(g, "reconcile").computeFn()
    expect(row.humanGating).toBe("N/A")
    expect(row.agreement).toBe(true)
  })
})

describe("deterministic trace scoring", () => {
  test("every committed fixture scores exactly its declared ground truth", () => {
    for (const testCase of source as any[]) {
      const scored = scoreTrace({ caseId: testCase.id, trace: testCase.trace })
      for (const axis of AXES) {
        expect(`${testCase.id}.${axis}=${scored[axis]}`).toBe(`${testCase.id}.${axis}=${testCase.expect[axis]}`)
      }
      expect(`${testCase.id}.overall=${scored.overall}`).toBe(`${testCase.id}.overall=${testCase.expect.overall}`)
      expect(scored.violations === "none").toBe(testCase.expect.overall === "PASS")
    }
  })

  test("the fixture corpus covers a failure of every axis and a clean run", () => {
    const cases = source as any[]
    for (const axis of AXES) {
      expect(cases.some((c) => c.expect[axis] === "FAIL")).toBe(true)
    }
    expect(cases.some((c) => c.expect.overall === "PASS")).toBe(true)
  })

  test("maxConcurrent counts overlap, not adjacency", () => {
    expect(maxConcurrent([{ start: 0, end: 10 }, { start: 10, end: 20 }])).toBe(1)
    expect(maxConcurrent([{ start: 0, end: 10 }, { start: 5, end: 20 }])).toBe(2)
    expect(maxConcurrent([])).toBe(0)
  })

  test("payload parsing rejects anything that is not a trace", () => {
    expect(parsePayload("").ok).toBe(false)
    expect(parsePayload("[]").ok).toBe(false)
    expect(parsePayload('{"trace":{"events":[]}}').ok).toBe(true)
    expect(unscorable("x", "boom").overall).toBe("N/A")
    expect(unscorable("x", "boom").violations).toBe("boom")
  })
})
