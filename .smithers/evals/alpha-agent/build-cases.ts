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
//
// The emitters are exported and pure so the test suite can assert that the
// committed cases.jsonl is exactly what this script would write today. Editing
// the source corpus without regenerating leaves the runnable suite stale, and
// nothing else in the repo reads the generated file.
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

export type CaseLine = {
  id: string
  input: { carriedFindings: string }
  expected: { status: string; outputContains: Record<string, Record<string, unknown>[]> }
  metadata: { description: string }
}

const HERE = new URL(".", import.meta.url).pathname

/** The generated wire-format file this script owns. */
export const CASES_JSONL = join(HERE, "cases.jsonl")

/** The id of the synthetic case that has no entry in cases.source.json. */
export const UNPARSABLE_CASE_ID = "unparsable-payload"

const axisExpectations = (expect: SourceCase["expect"]): Record<string, Verdict> =>
  Object.fromEntries(AXES.map((axis) => [axis, expect[axis] as Verdict]))

/** Every case `smithers eval` runs, in file order. Pure: no I/O, no clock. */
export function buildCases(): CaseLine[] {
  const lines = (source as SourceCase[]).map((testCase): CaseLine => {
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
  // "N/A" and skipping the judge entirely (no model call, no verdict row). It
  // has no trace, so it is synthesised here rather than authored in the source.
  lines.push({
    id: UNPARSABLE_CASE_ID,
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
  })

  return lines
}

/** The exact bytes of cases.jsonl, so parity can be asserted on the text. */
export function casesJsonl(): string {
  return `${buildCases().map((line) => JSON.stringify(line)).join("\n")}\n`
}

if (import.meta.main) {
  writeFileSync(CASES_JSONL, casesJsonl())
  process.stdout.write(`wrote ${buildCases().length} cases to ${CASES_JSONL}\n`)
}
