/** @jsxImportSource react */
// Graph-shape tests for the alpha-agent eval judge. Renders the REAL workflow
// module through renderWorkflow and asserts the node ids, ordering, output
// schemas, and the conditional that skips the model call when a case payload
// does not parse. The deterministic scorer that backs the suite's ground truth
// is unit-tested here too, against the committed fixtures.
// @ts-expect-error bun:test types are provided by the bun runtime, not @types/node
import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { renderWorkflow } from "smthrs/testing"
import source from "../evals/alpha-agent/cases.source.json" with { type: "json" }
import {
  AXES,
  maxConcurrent,
  panelRounds,
  parsePayload,
  scoreTrace,
  type TraceEvent,
  unscorable,
} from "../evals/alpha-agent/scoreTrace.ts"
import workflow, { JUDGE_SCRATCH_DIR } from "../workflows/alpha-agent-eval-judge.tsx"

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

  test("every judge seat is hermetic: no yolo, no tools, no settings, no MCP, scratch cwd", async () => {
    const seats = pick(await render(payloadOf("golden-full-run")), "rubricJudge").agent as any[]
    // The fallback chain is the account seats plus the ambient-credentials seat.
    // The restrictions hold for EVERY entry, not just the first one tried.
    expect(Array.isArray(seats)).toBe(true)
    expect(seats.length).toBeGreaterThan(1)
    const checkout = resolve(import.meta.dir, "..", "..")
    expect(existsSync(JUDGE_SCRATCH_DIR)).toBe(true)
    expect(JUDGE_SCRATCH_DIR.startsWith(checkout)).toBe(false)

    for (const seat of seats) {
      expect(seat.opts.model).toBe("claude-sonnet-5")
      // BaseCliAgent defaults yolo to true; a judge must not inherit that.
      expect(seat.yolo).toBe(false)
      expect(seat.opts.yolo).toBe(false)
      expect(seat.opts.permissionMode).toBe("default")
      expect(seat.opts.tools).toBe("")
      expect(seat.opts.settingSources).toBe("")
      expect(seat.opts.strictMcpConfig).toBe(true)
      expect(seat.opts.mcpConfig).toEqual([])
      expect(seat.opts.disableSlashCommands).toBe(true)
      expect(seat.opts.addDir).toEqual([])
      // No repository access: the cwd is an empty scratch dir outside the tree.
      expect(seat.cwd).toBe(JUDGE_SCRATCH_DIR)
      expect(seat.capabilities.builtIns).toEqual([])

      // The command line is the real trust boundary, so assert on it directly.
      const built = await seat.buildCommand({ prompt: "grade this", cwd: seat.cwd, options: {} })
      const args: string[] = built.args
      const line = args.join(" ")
      for (const banned of [
        "--dangerously-skip-permissions",
        "--allow-dangerously-skip-permissions",
        "--mcp-config",
        "--add-dir",
        "--plugin-dir",
        "--allowed-tools",
      ]) {
        expect(`${seat.opts.id ?? "ambient"} ${banned}: ${args.includes(banned)}`).toBe(
          `${seat.opts.id ?? "ambient"} ${banned}: false`,
        )
      }
      expect(line).not.toContain("bypassPermissions")
      expect(args).toContain("--disable-slash-commands")
      expect(args).toContain("--strict-mcp-config")
      expect(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2)).toEqual(["--tools", ""])
      expect(args.slice(args.indexOf("--setting-sources"), args.indexOf("--setting-sources") + 2)).toEqual([
        "--setting-sources",
        "",
      ])
      await built.cleanup?.()
    }
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

  test("polish convergence ignores anything logged before the lane landed", () => {
    // A pre-land LGTM is pre-merge work. Scoring it as polish would let a lane
    // reach main and never be looked at again while the axis reads PASS.
    const preLand = scoreTrace({
      caseId: "pre-land",
      trace: {
        events: [
          { tMin: 0, node: "a1Impl", phase: "impl", event: "start", lane: "a1" },
          { tMin: 10, node: "a1Review", phase: "review", event: "finish", lane: "a1", verdict: "APPROVE" },
          { tMin: 12, node: "a1PolishReview", phase: "polishReview", event: "finish", lane: "a1", verdict: "LGTM" },
          { tMin: 20, node: "a1Land", phase: "land", event: "finish", lane: "a1", landed: true },
        ] satisfies TraceEvent[],
      },
    })
    expect(preLand.polishConvergence).toBe("FAIL")
    expect(preLand.violations).toContain("no post-land polish review")

    const postLand = scoreTrace({
      caseId: "post-land",
      trace: {
        events: [
          { tMin: 0, node: "a1Impl", phase: "impl", event: "start", lane: "a1" },
          { tMin: 10, node: "a1Review", phase: "review", event: "finish", lane: "a1", verdict: "APPROVE" },
          { tMin: 20, node: "a1Land", phase: "land", event: "finish", lane: "a1", landed: true },
          { tMin: 30, node: "a1PolishReview", phase: "polishReview", event: "finish", lane: "a1", verdict: "LGTM" },
        ] satisfies TraceEvent[],
      },
    })
    expect(postLand.polishConvergence).toBe("PASS")

    // A FIX applied before the landing does not satisfy a post-land FIX either.
    const staleFix = scoreTrace({
      caseId: "stale-fix",
      trace: {
        events: [
          { tMin: 0, node: "a1Impl", phase: "impl", event: "start", lane: "a1" },
          { tMin: 10, node: "a1Review", phase: "review", event: "finish", lane: "a1", verdict: "APPROVE" },
          { tMin: 15, node: "a1PolishFix", phase: "polishFix", event: "finish", lane: "a1" },
          { tMin: 20, node: "a1Land", phase: "land", event: "finish", lane: "a1", landed: true },
          { tMin: 30, node: "a1PolishReview", phase: "polishReview", event: "finish", lane: "a1", verdict: "FIX" },
          { tMin: 40, node: "a1PolishReview", phase: "polishReview", event: "finish", lane: "a1", verdict: "LGTM" },
        ] satisfies TraceEvent[],
      },
    })
    expect(staleFix.polishConvergence).toBe("FAIL")
    expect(staleFix.violations).toContain("ran no fix-forward task")
  })

  test("a landing that precedes its own review is not an immediate landing", () => {
    const trace = (landAt: number) => ({
      caseId: `land-${landAt}`,
      trace: {
        events: [
          { tMin: 0, node: "a1Impl", phase: "impl", event: "start", lane: "a1" },
          { tMin: 40, node: "a1Impl", phase: "impl", event: "finish", lane: "a1" },
          { tMin: 50, node: "a1Review", phase: "review", event: "finish", lane: "a1", verdict: "APPROVE" },
          { tMin: landAt, node: "a1Land", phase: "land", event: "finish", lane: "a1", landed: true },
          { tMin: 90, node: "a1PolishReview", phase: "polishReview", event: "finish", lane: "a1", verdict: "LGTM" },
        ] satisfies TraceEvent[],
      },
    })
    // A negative gap used to slip past the ceiling test and score PASS.
    const early = scoreTrace(trace(45))
    expect(early.immediateLanding).toBe("FAIL")
    expect(early.violations).toContain("BEFORE it cleared review")
    expect(scoreTrace(trace(55)).immediateLanding).toBe("PASS")
    expect(scoreTrace(trace(200)).immediateLanding).toBe("FAIL")
  })

  test("panel rounds split on a repeated verifier and on a remediation", () => {
    const events: TraceEvent[] = [
      { tMin: 10, node: "panelCodex", phase: "panel", event: "finish", verifier: "codex", verdict: "NOT-READY" },
      { tMin: 12, node: "panelFable", phase: "panel", event: "finish", verifier: "fable", verdict: "PRODUCTION-READY" },
      { tMin: 20, node: "panelRemediate", phase: "remediate", event: "finish" },
      { tMin: 30, node: "panelCodex", phase: "panel", event: "finish", verifier: "codex", verdict: "PRODUCTION-READY" },
      { tMin: 32, node: "panelFable", phase: "panel", event: "finish", verifier: "fable", verdict: "PRODUCTION-READY" },
    ]
    expect(panelRounds(events).map((round) => round.map((e) => `${e.verifier}@${e.tMin}`))).toEqual([
      ["codex@10", "fable@12"],
      ["codex@30", "fable@32"],
    ])
    // A remediation alone opens a round even when no verifier repeats.
    expect(
      panelRounds([
        { tMin: 10, node: "p", phase: "panel", event: "finish", verifier: "codex", verdict: "NOT-READY" },
        { tMin: 20, node: "r", phase: "remediate", event: "finish" },
        { tMin: 30, node: "p", phase: "panel", event: "finish", verifier: "fable", verdict: "PRODUCTION-READY" },
      ]).length,
    ).toBe(2)
    expect(panelRounds([]).length).toBe(0)
  })

  test("the human gate needs two fresh verdicts from the latest panel round", () => {
    const lane: TraceEvent[] = [
      { tMin: 0, node: "a1Impl", phase: "impl", event: "start", lane: "a1" },
      { tMin: 40, node: "a1Impl", phase: "impl", event: "finish", lane: "a1" },
      { tMin: 50, node: "a1Review", phase: "review", event: "finish", lane: "a1", verdict: "APPROVE" },
      { tMin: 55, node: "a1Land", phase: "land", event: "finish", lane: "a1", landed: true },
      { tMin: 70, node: "a1PolishReview", phase: "polishReview", event: "finish", lane: "a1", verdict: "LGTM" },
    ]
    const failedRound: TraceEvent[] = [
      { tMin: 100, node: "panelCodex", phase: "panel", event: "finish", verifier: "codex", verdict: "NOT-READY" },
      { tMin: 102, node: "panelFable", phase: "panel", event: "finish", verifier: "fable", verdict: "PRODUCTION-READY" },
      { tMin: 110, node: "panelRemediate", phase: "remediate", event: "finish" },
    ]
    const gate: TraceEvent = { tMin: 200, node: "humanRatify", phase: "human", event: "start", kind: "gated-task" }

    // Only codex re-ran. The stale fable PRODUCTION-READY from the failed round
    // must not combine with it to open the gate.
    const partial = scoreTrace({
      caseId: "partial-rerun",
      trace: {
        events: [
          ...lane,
          ...failedRound,
          { tMin: 150, node: "panelCodex", phase: "panel", event: "finish", verifier: "codex", verdict: "PRODUCTION-READY" },
          gate,
        ],
      },
    })
    expect(partial.humanGating).toBe("FAIL")
    expect(partial.violations).toContain("panel round 2 of 2")

    // Both verifiers re-ran: the gate opens.
    const full = scoreTrace({
      caseId: "full-rerun",
      trace: {
        events: [
          ...lane,
          ...failedRound,
          { tMin: 150, node: "panelCodex", phase: "panel", event: "finish", verifier: "codex", verdict: "PRODUCTION-READY" },
          { tMin: 155, node: "panelFable", phase: "panel", event: "finish", verifier: "fable", verdict: "PRODUCTION-READY" },
          gate,
        ],
      },
    })
    expect(full.humanGating).toBe("PASS")

    // The second verifier reported only after the task was raised.
    const raced = scoreTrace({
      caseId: "raced",
      trace: {
        events: [
          ...lane,
          { tMin: 150, node: "panelCodex", phase: "panel", event: "finish", verifier: "codex", verdict: "PRODUCTION-READY" },
          { tMin: 210, node: "panelFable", phase: "panel", event: "finish", verifier: "fable", verdict: "PRODUCTION-READY" },
          gate,
        ],
      },
    })
    expect(raced.humanGating).toBe("FAIL")
    expect(raced.violations).toContain("reported only afterwards")

    // Round-qualified panel facts make the stale verdict visible in `stats`.
    expect(JSON.parse(partial.stats).panelVerdicts).toEqual([
      "r1:codex=NOT-READY",
      "r1:fable=PRODUCTION-READY",
      "r2:codex=PRODUCTION-READY",
    ])
  })

  test("payload parsing rejects anything that is not a trace", () => {
    expect(parsePayload("").ok).toBe(false)
    expect(parsePayload("[]").ok).toBe(false)
    expect(parsePayload('{"trace":{"events":[]}}').ok).toBe(true)
    expect(unscorable("x", "boom").overall).toBe("N/A")
    expect(unscorable("x", "boom").violations).toBe("boom")
  })
})
