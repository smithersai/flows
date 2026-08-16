/** @jsxImportSource smthrs */
import { readFileSync } from "node:fs"
import { expect, test } from "bun:test"
import { renderWorkflow } from "smthrs/testing"
import workflow, { DOCTRINE, DOCTRINE_RULES } from "../workflows/alpha-ui-evals.tsx"

type AnyTask = {
  nodeId: string
  prompt?: string
  agent?: unknown
  outputSchema?: { safeParse: (v: unknown) => { success: boolean } }
}

const CASES_PATH = new URL("../evals/alpha-ui-cases.jsonl", import.meta.url).pathname

type EvalCase = {
  id: string
  input: { scenario?: string }
  expected: { status: string; outputContains: { judgment: Array<{ rule: string; verdict: string }> } }
}

/**
 * Parses the case file exactly the way `smthrs eval` does: every non-blank
 * line must be JSON. The CLI's `.jsonl` reader has no comment support (unlike
 * `parseEvalDataset` in @smthrs/scorers, which skips `#` lines), so a comment
 * here is a hard INVALID_JSON at run time. Keeping the reader strict makes that
 * a test failure instead of a failed eval run.
 */
const readCases = (): EvalCase[] =>
  readFileSync(CASES_PATH, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as EvalCase)

const render = async (scenario: string) =>
  renderWorkflow(workflow as never, {
    input: { scenario },
    runId: "alpha-ui-evals-test",
  })

const tasksOf = (frame: { tasks: readonly unknown[] }) => frame.tasks as readonly AnyTask[]
const taskOf = (frame: { tasks: readonly unknown[] }, nodeId: string) => {
  const found = tasksOf(frame).find((t) => t.nodeId === nodeId)
  if (!found) throw new Error(`task ${nodeId} was not rendered`)
  return found
}

test("the suite renders exactly one judge task", async () => {
  const frame = await render("Three lanes cleared review at the same moment.")
  expect(tasksOf(frame).map((t) => t.nodeId)).toEqual(["judge"])
  // A fallback pool, so one account's quota cannot grade a case INCONCLUSIVE.
  expect(Array.isArray(taskOf(frame, "judge").agent)).toBe(true)
})

test("the judge prompt carries the scenario and the full doctrine", async () => {
  const scenario = "The reviewer asked for a second pre-merge pass on lane U3."
  const prompt = taskOf(await render(scenario), "judge").prompt ?? ""
  expect(prompt).toContain(scenario)
  expect(prompt).toContain(DOCTRINE.trim())
  for (const rule of DOCTRINE_RULES) {
    expect(prompt).toContain(rule)
  }
})

test("the judgment schema pins the doctrine vocabulary and rejects thin answers", async () => {
  const schema = taskOf(await render("A lane cleared review."), "judge").outputSchema
  if (!schema) throw new Error("judge has no output schema")
  expect(schema.safeParse({}).success).toBe(false)
  const ok = {
    rule: "single-pre-merge-review",
    verdict: "refuse",
    action: "Land the lane on main now.",
    rationale: "r".repeat(40),
  }
  expect(schema.safeParse(ok).success).toBe(true)
  // An invented rule name would silently pass every outputContains assertion.
  expect(schema.safeParse({ ...ok, rule: "second-review" }).success).toBe(false)
  expect(schema.safeParse({ ...ok, verdict: "maybe" }).success).toBe(false)
  // A one-word action or rationale is not an executable next step.
  expect(schema.safeParse({ ...ok, action: "no" }).success).toBe(false)
  expect(schema.safeParse({ ...ok, rationale: "because" }).success).toBe(false)
})

test("every case file row is gradeable against the judgment schema", async () => {
  const schema = taskOf(await render("A lane cleared review."), "judge").outputSchema
  if (!schema) throw new Error("judge has no output schema")
  const cases = readCases()
  expect(cases.length).toBeGreaterThanOrEqual(10)
  const ids = new Set<string>()
  for (const testCase of cases) {
    expect(ids.has(testCase.id)).toBe(false)
    ids.add(testCase.id)
    expect(testCase.input.scenario ?? "").not.toBe("")
    expect(testCase.expected.status).toBe("finished")
    const [expectedRow] = testCase.expected.outputContains.judgment
    expect(
      schema.safeParse({
        ...expectedRow,
        action: "a".repeat(20),
        rationale: "b".repeat(40),
      }).success,
    ).toBe(true)
  }
})

test("the case file covers every doctrine rule in both directions", async () => {
  const cases = readCases()
  for (const rule of DOCTRINE_RULES) {
    const forRule = cases
      .map((c) => c.expected.outputContains.judgment[0])
      .filter((row) => row?.rule === rule)
    expect(forRule.some((row) => row?.verdict === "refuse")).toBe(true)
    expect(forRule.some((row) => row?.verdict === "proceed")).toBe(true)
  }
})

test("the judge task is deterministic across renders of the same input", async () => {
  const scenario = "Lane U2 cleared review while the panel has not run."
  const first = taskOf(await render(scenario), "judge").prompt
  const second = taskOf(await render(scenario), "judge").prompt
  expect(first).toBe(second)
})
