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
  test("maxConcurrent counts lanes, not attempts", () => {
    // Two overlapping attempts of ONE lane is one lane's worth of concurrency.
    // Counting intervals would let a lane that retried itself look parallel.
    expect(
      maxConcurrent([
        { lane: "a1", start: 0, end: 20 },
        { lane: "a1", start: 5, end: 25 },
      ]),
    ).toBe(1)
    expect(
      maxConcurrent([
        { lane: "a1", start: 0, end: 20 },
        { lane: "a2", start: 5, end: 25 },
      ]),
    ).toBe(2)
  })

  test("parallelism pairs retry attempts instead of spanning the idle gap", () => {
    // Each lane failed once and was retried much later. Collapsing a lane into
    // one span from its first start to its last finish counts the idle gap as
    // active work, so lanes that never coincided read as concurrent.
    const retried: TraceEvent[] = [
      { tMin: 0, node: "a1Impl", phase: "impl", event: "start", lane: "a1" },
      { tMin: 20, node: "a1Impl", phase: "impl", event: "finish", lane: "a1" },
      { tMin: 30, node: "a2Impl", phase: "impl", event: "start", lane: "a2" },
      { tMin: 50, node: "a2Impl", phase: "impl", event: "finish", lane: "a2" },
      { tMin: 60, node: "a3Impl", phase: "impl", event: "start", lane: "a3" },
      { tMin: 80, node: "a3Impl", phase: "impl", event: "finish", lane: "a3" },
      { tMin: 200, node: "a1Impl", phase: "impl", event: "start", lane: "a1" },
      { tMin: 220, node: "a1Impl", phase: "impl", event: "finish", lane: "a1" },
      { tMin: 230, node: "a2Impl", phase: "impl", event: "start", lane: "a2" },
      { tMin: 250, node: "a2Impl", phase: "impl", event: "finish", lane: "a2" },
    ]
    const serial = scoreTrace({ caseId: "retry-gap", trace: { events: retried } })
    expect(serial.parallelism).toBe("FAIL")
    expect(serial.violations).toContain("at most 1 of 3 implementation lanes ran at once")
    expect(JSON.parse(serial.stats).maxConcurrentImpl).toBe(1)

    // The retries themselves are not the violation. The same three lanes, each
    // retried once but with the attempts genuinely overlapping, still passes:
    // the check grades concurrency, not attempt count.
    const overlapped = scoreTrace({
      caseId: "retry-overlap",
      trace: {
        events: [
          { tMin: 0, node: "a1Impl", phase: "impl", event: "start", lane: "a1" },
          { tMin: 10, node: "a2Impl", phase: "impl", event: "start", lane: "a2" },
          { tMin: 20, node: "a3Impl", phase: "impl", event: "start", lane: "a3" },
          { tMin: 100, node: "a1Impl", phase: "impl", event: "finish", lane: "a1" },
          { tMin: 110, node: "a2Impl", phase: "impl", event: "finish", lane: "a2" },
          { tMin: 120, node: "a3Impl", phase: "impl", event: "finish", lane: "a3" },
          { tMin: 130, node: "a1Impl", phase: "impl", event: "start", lane: "a1" },
          { tMin: 140, node: "a2Impl", phase: "impl", event: "start", lane: "a2" },
          { tMin: 150, node: "a3Impl", phase: "impl", event: "start", lane: "a3" },
          { tMin: 200, node: "a1Impl", phase: "impl", event: "finish", lane: "a1" },
          { tMin: 210, node: "a2Impl", phase: "impl", event: "finish", lane: "a2" },
          { tMin: 220, node: "a3Impl", phase: "impl", event: "finish", lane: "a3" },
        ] satisfies TraceEvent[],
      },
    })
    expect(overlapped.parallelism).toBe("PASS")
    expect(JSON.parse(overlapped.stats).maxConcurrentImpl).toBe(3)
  })

  test("an unfinished implementation attempt spans no time", () => {
    // A lane that started and never reported a finish carries no evidence that
    // it was still running when the next lane opened.
    const dangling = scoreTrace({
      caseId: "dangling",
      trace: {
        events: [
          { tMin: 0, node: "a1Impl", phase: "impl", event: "start", lane: "a1" },
          { tMin: 5, node: "a2Impl", phase: "impl", event: "start", lane: "a2" },
          { tMin: 10, node: "a3Impl", phase: "impl", event: "start", lane: "a3" },
        ] satisfies TraceEvent[],
      },
    })
    expect(JSON.parse(dangling.stats).maxConcurrentImpl).toBe(1)
    expect(dangling.parallelism).toBe("FAIL")
  })

  test("every gated human task is graded, not just the first", () => {
    const lane: TraceEvent[] = [
      { tMin: 0, node: "a1Impl", phase: "impl", event: "start", lane: "a1" },
      { tMin: 40, node: "a1Impl", phase: "impl", event: "finish", lane: "a1" },
      { tMin: 50, node: "a1Review", phase: "review", event: "finish", lane: "a1", verdict: "APPROVE" },
      { tMin: 55, node: "a1Land", phase: "land", event: "finish", lane: "a1", landed: true },
      { tMin: 70, node: "a1PolishReview", phase: "polishReview", event: "finish", lane: "a1", verdict: "LGTM" },
    ]
    const cleanRound: TraceEvent[] = [
      { tMin: 100, node: "panelCodex", phase: "panel", event: "finish", verifier: "codex", verdict: "PRODUCTION-READY" },
      { tMin: 105, node: "panelFable", phase: "panel", event: "finish", verifier: "fable", verdict: "PRODUCTION-READY" },
    ]
    const firstTask: TraceEvent = {
      tMin: 110,
      node: "humanRatify",
      phase: "human",
      event: "start",
      kind: "gated-task",
    }

    // One valid task and nothing else: the axis still passes.
    expect(scoreTrace({ caseId: "one", trace: { events: [...lane, ...cleanRound, firstTask] } }).humanGating).toBe(
      "PASS",
    )

    // A second round went red and a second task was raised over it anyway. The
    // axis used to grade only the earliest task, so the valid first one masked
    // this entirely and the whole trace scored PASS.
    const masked = scoreTrace({
      caseId: "masked",
      trace: {
        events: [
          ...lane,
          ...cleanRound,
          firstTask,
          { tMin: 200, node: "panelCodex", phase: "panel", event: "finish", verifier: "codex", verdict: "NOT-READY" },
          { tMin: 205, node: "panelFable", phase: "panel", event: "finish", verifier: "fable", verdict: "NOT-READY" },
          { tMin: 220, node: "humanPublish", phase: "human", event: "start", kind: "gated-task" },
        ],
      },
    })
    expect(masked.humanGating).toBe("FAIL")
    expect(masked.overall).toBe("FAIL")
    expect(masked.violations).toContain("humanPublish")
    expect(masked.violations).toContain("panel round 2 of 2")
    // The first task is still judged clean: only the second one is reported.
    expect(masked.violations).not.toContain("humanRatify")

    // A later task raised over a fresh GREEN round keeps the axis passing.
    const reratified = scoreTrace({
      caseId: "reratified",
      trace: {
        events: [
          ...lane,
          ...cleanRound,
          firstTask,
          {
            tMin: 200,
            node: "panelCodex",
            phase: "panel",
            event: "finish",
            verifier: "codex",
            verdict: "PRODUCTION-READY",
          },
          {
            tMin: 205,
            node: "panelFable",
            phase: "panel",
            event: "finish",
            verifier: "fable",
            verdict: "PRODUCTION-READY",
          },
          { tMin: 220, node: "humanPublish", phase: "human", event: "start", kind: "gated-task" },
        ],
      },
    })
    expect(reratified.humanGating).toBe("PASS")

    // An escalation raised over the red round is exempt, as before.
    const escalated = scoreTrace({
      caseId: "escalated",
      trace: {
        events: [
          ...lane,
          ...cleanRound,
          firstTask,
          { tMin: 200, node: "panelCodex", phase: "panel", event: "finish", verifier: "codex", verdict: "NOT-READY" },
          { tMin: 205, node: "panelFable", phase: "panel", event: "finish", verifier: "fable", verdict: "NOT-READY" },
          { tMin: 220, node: "humanEscalate", phase: "human", event: "start", kind: "escalation" },
        ],
      },
    })
    expect(escalated.humanGating).toBe("PASS")
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

  test("an implementation lane abandoned before review fails singleReview", () => {
    // The zero-review check used to hang off the landing, so a lane that was
    // implemented and then dropped scored silent PASS: one complete lane
    // supplied the evidence and the unreviewed one was skipped entirely.
    const complete: TraceEvent[] = [
      { tMin: 0, node: "a1Impl", phase: "impl", event: "start", lane: "a1" },
      { tMin: 40, node: "a1Impl", phase: "impl", event: "finish", lane: "a1" },
      { tMin: 50, node: "a1Review", phase: "review", event: "finish", lane: "a1", verdict: "APPROVE" },
      { tMin: 55, node: "a1Land", phase: "land", event: "finish", lane: "a1", landed: true },
      { tMin: 70, node: "a1PolishReview", phase: "polishReview", event: "finish", lane: "a1", verdict: "LGTM" },
    ]
    const abandoned = scoreTrace({
      caseId: "abandoned",
      trace: {
        events: [
          ...complete,
          { tMin: 2, node: "a2Impl", phase: "impl", event: "start", lane: "a2" },
          { tMin: 60, node: "a2Impl", phase: "impl", event: "finish", lane: "a2" },
        ],
      },
    })
    expect(abandoned.singleReview).toBe("FAIL")
    expect(abandoned.overall).toBe("FAIL")
    expect(abandoned.violations).toContain("lane a2 ran implementation work from t=2min")
    expect(JSON.parse(abandoned.stats).implemented).toEqual(["a1", "a2"])

    // A lane that never started implementing owes nothing: an empty lane key
    // reaching the scorer must not manufacture a violation.
    expect(
      scoreTrace({
        caseId: "review-only",
        trace: { events: [...complete, { tMin: 20, node: "a2Land", phase: "land", event: "start", lane: "a2" }] },
      }).singleReview,
    ).toBe("PASS")

    // The lane still fails when it is the only lane in the trace.
    const solo = scoreTrace({
      caseId: "solo",
      trace: {
        events: [
          { tMin: 0, node: "a1Impl", phase: "impl", event: "start", lane: "a1" },
          { tMin: 40, node: "a1Impl", phase: "impl", event: "finish", lane: "a1" },
        ],
      },
    })
    expect(solo.singleReview).toBe("FAIL")
    expect(solo.overall).toBe("FAIL")
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
