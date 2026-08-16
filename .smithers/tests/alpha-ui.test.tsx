/** @jsxImportSource smthrs */
import { expect, test } from "bun:test"
import { renderWorkflow } from "smthrs/testing"
import workflow from "../workflows/alpha-ui.tsx"

const LANE_KEYS = ["u1", "u2", "u3", "u4", "u5", "u6", "u7", "u8", "evals"]

type AnyTask = {
  nodeId: string
  skipIf?: boolean
  outputSchema?: { safeParse: (v: unknown) => { success: boolean } }
}

const render = async (outputs: Record<string, unknown[]> = {}) =>
  renderWorkflow(workflow as never, {
    input: { carriedFindings: "" },
    outputs: outputs as never,
    runId: "alpha-ui-test",
  })

const tasksOf = (frame: { tasks: readonly unknown[] }) => frame.tasks as readonly AnyTask[]
const idsOf = (frame: { tasks: readonly unknown[] }) => tasksOf(frame).map((t) => t.nodeId)
const taskOf = (frame: { tasks: readonly unknown[] }, nodeId: string) => {
  const found = tasksOf(frame).find((t) => t.nodeId === nodeId)
  if (!found) throw new Error(`task ${nodeId} was not rendered`)
  return found
}

test("frame 0 renders every lane pipeline, the land queue, the panel, and the gate", async () => {
  const frame = await render()
  const ids = idsOf(frame)
  for (const key of LANE_KEYS) {
    expect(ids).toContain(`${key}Impl`)
    expect(ids).toContain(`${key}Review`)
    expect(ids).toContain(`${key}Fix`)
    expect(ids).toContain(`${key}LandRun`)
    expect(ids).toContain(`${key}LandVerify`)
    // Polish loops mount only after a deterministically verified land.
    expect(ids).not.toContain(`${key}PolishReview`)
    expect(ids).not.toContain(`${key}PolishFix`)
  }
  expect(ids).toContain("panelCodex")
  expect(ids).toContain("panelFable")
  expect(ids).toContain("panelFix")
  expect(ids).toContain("humanTasksDoc")
  expect(ids).toContain("humanGate")
})

test("lane pipeline order: impl before review before fix, land after the lane", async () => {
  const frame = await render()
  const ids = idsOf(frame)
  for (const key of LANE_KEYS) {
    expect(ids.indexOf(`${key}Impl`)).toBeLessThan(ids.indexOf(`${key}Review`))
    expect(ids.indexOf(`${key}Review`)).toBeLessThan(ids.indexOf(`${key}Fix`))
    expect(ids.indexOf(`${key}Review`)).toBeLessThan(ids.indexOf(`${key}LandRun`))
    expect(ids.indexOf(`${key}LandRun`)).toBeLessThan(ids.indexOf(`${key}LandVerify`))
    // Lands are gated by sequence position, never by skipIf: a skipIf that is
    // true at frame 0 is a PERMANENT skip in the engine (learned live).
    expect(Boolean(taskOf(frame, `${key}LandRun`).skipIf)).toBe(false)
    expect(Boolean(taskOf(frame, `${key}LandVerify`).skipIf)).toBe(false)
  }
  // The panel fix step is gated off until a panelist reports NOT-READY.
  expect(taskOf(frame, "panelFix").skipIf).toBe(true)
})

test("task output schemas are the intended ones and reject empty rows", async () => {
  const frame = await render()
  const impl = taskOf(frame, "u1Impl").outputSchema
  if (!impl) throw new Error("u1Impl has no output schema")
  expect(impl.safeParse({}).success).toBe(false)
  expect(
    impl.safeParse({
      laneKey: "u1",
      summary: "a".repeat(50),
      testsAdded: "card.test.tsx",
      gatesGreen: true,
      commitTip: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      blocked: "none",
    }).success,
  ).toBe(true)
  const review = taskOf(frame, "u1Review").outputSchema
  if (!review) throw new Error("u1Review has no output schema")
  expect(
    review.safeParse({ laneKey: "u1", verdict: "maybe", findings: "none", summary: "b".repeat(50) }).success,
  ).toBe(false)
  expect(
    review.safeParse({ laneKey: "u1", verdict: "approve", findings: "none", summary: "b".repeat(50) }).success,
  ).toBe(true)
  const panel = taskOf(frame, "panelCodex").outputSchema
  if (!panel) throw new Error("panelCodex has no output schema")
  expect(
    panel.safeParse({ panelist: "codex-sol", verdict: "PRODUCTION-READY", failures: "none", summary: "c".repeat(50) })
      .success,
  ).toBe(true)
  expect(panel.safeParse({ panelist: "codex-sol", verdict: "meh", failures: "none", summary: "c".repeat(50) }).success).toBe(
    false,
  )
})

test("an approved review opens the lane's land task and skips its fix step", async () => {
  const frame = await render({
    alphaUiReview: [
      { nodeId: "u1Review", laneKey: "u1", verdict: "approve", findings: "none", summary: "s".repeat(50) },
    ],
  })
  expect(taskOf(frame, "u1Fix").skipIf).toBe(true)
  // Land tasks stay schedulable-by-sequence, never skipIf-gated.
  expect(Boolean(taskOf(frame, "u1LandRun").skipIf)).toBe(false)
  expect(taskOf(frame, "u2Fix").skipIf).toBe(false)
})

test("a fix-verdict review keeps the land gated until the fix row lands", async () => {
  const reviewRow = {
    nodeId: "u3Review",
    laneKey: "u3",
    verdict: "fix",
    findings: "1. apps/ui/src/x.tsx:10 broken",
    summary: "s".repeat(50),
  }
  const before = await render({ alphaUiReview: [reviewRow] })
  expect(taskOf(before, "u3Fix").skipIf).toBe(false)
  const after = await render({
    alphaUiReview: [reviewRow],
    alphaUiFix: [
      {
        nodeId: "u3Fix",
        laneKey: "u3",
        summary: "fixed the finding end to end",
        addressed: "1 fixed",
        commitTip: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      },
    ],
  })
  expect(taskOf(after, "u3Fix").skipIf).toBe(false)
})

test("a verified land mounts the lane's polish loop and lgtm skips the polish fix", async () => {
  const landCheck = {
    nodeId: "u2LandVerify",
    laneKey: "u2",
    verifiedTip: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    onMain: true,
  }
  const opened = await render({ alphaUiLandCheck: [landCheck] })
  expect(idsOf(opened)).toContain("u2PolishReview")
  expect(idsOf(opened)).not.toContain("u1PolishReview")
  const lgtm = await render({
    alphaUiLandCheck: [landCheck],
    alphaUiPolish: [
      {
        nodeId: "u2PolishReview",
        laneKey: "u2",
        verdict: "lgtm",
        findings: "none",
        gatesGreen: true,
        summary: "p".repeat(40),
      },
    ],
  })
  expect(taskOf(lgtm, "u2PolishFix").skipIf).toBe(true)
})

test("panel failures open the panel fix step; a passing panel keeps it skipped", async () => {
  const failing = await render({
    alphaUiPanel: [
      { nodeId: "panelCodex", panelist: "codex-sol", verdict: "NOT-READY", failures: "U4 gap", summary: "x".repeat(50) },
      {
        nodeId: "panelFable",
        panelist: "claude-fable",
        verdict: "PRODUCTION-READY",
        failures: "none",
        summary: "y".repeat(50),
      },
    ],
  })
  expect(taskOf(failing, "panelFix").skipIf).toBe(false)
  const passing = await render({
    alphaUiPanel: [
      {
        nodeId: "panelCodex",
        panelist: "codex-sol",
        verdict: "PRODUCTION-READY",
        failures: "none",
        summary: "x".repeat(50),
      },
      {
        nodeId: "panelFable",
        panelist: "claude-fable",
        verdict: "PRODUCTION-READY",
        failures: "none",
        summary: "y".repeat(50),
      },
    ],
  })
  expect(taskOf(passing, "panelFix").skipIf).toBe(true)
})
