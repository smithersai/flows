#!/usr/bin/env bun
// Generate cases.jsonl from cases.source.json.
//
// `smithers eval` reads one JSON object per line, and every case must smuggle
// its payload through the run store's single user input column
// (`carriedFindings`, TEXT) as a JSON string. Hand-escaping traces into JSONL
// is unreadable, so the traces and their ground truth live in the readable
// cases.source.json and this script mechanically emits the wire format.
//
//   bun .smithers/evals/alpha-agent/build-cases.ts
//
// Run it after editing cases.source.json and commit both files.
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import source from "./cases.source.json" with { type: "json" }
import { AXES, type OrchestratorTrace, type Verdict } from "./scoreTrace.ts"

type SourceCase = {
  id: string
  description: string
  expect: Record<string, Verdict | boolean> & { overall: Verdict; agreement?: boolean }
  trace: OrchestratorTrace
}

const HERE = new URL(".", import.meta.url).pathname

const axisExpectations = (expect: SourceCase["expect"]): Record<string, Verdict> =>
  Object.fromEntries(AXES.map((axis) => [axis, expect[axis] as Verdict]))

const lines = (source as SourceCase[]).map((testCase) => {
  const axes = axisExpectations(testCase.expect)
  // The deterministic checks decide the axes, so both rows are asserted: the
  // checker's row proves the trace scoring, the verdict row proves the
  // reconciliation and (where the case is clear-cut) the judge's agreement.
  const verdictRow: Record<string, unknown> = { caseId: testCase.id, ...axes, overall: testCase.expect.overall }
  if (typeof testCase.expect.agreement === "boolean") verdictRow.agreement = testCase.expect.agreement
  return {
    id: testCase.id,
    input: {
      carriedFindings: JSON.stringify({ caseId: testCase.id, trace: testCase.trace }),
    },
    expected: {
      status: "finished",
      outputContains: {
        alphaEvalJudgeChecks: [{ caseId: testCase.id, ...axes, overall: testCase.expect.overall }],
        alphaEvalJudgeVerdict: [verdictRow],
      },
    },
    metadata: { description: testCase.description },
  }
})

// Degraded path: an unparsable payload must still finish, scoring every axis
// "N/A" and skipping the judge entirely (no model call, no verdict row).
lines.push({
  id: "unparsable-payload",
  input: { carriedFindings: "not json at all" },
  expected: {
    status: "finished",
    outputContains: {
      alphaEvalJudgeChecks: [
        { caseId: "unparsed", ...Object.fromEntries(AXES.map((axis) => [axis, "N/A"])), overall: "N/A" },
      ],
    },
  },
  metadata: { description: "A malformed carriedFindings payload degrades to N/A instead of failing the run." },
} as (typeof lines)[number])

const out = join(HERE, "cases.jsonl")
writeFileSync(out, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`)
process.stdout.write(`wrote ${lines.length} cases to ${out}\n`)
