/**
 * Author a proof of concept for one report.
 *
 * Runs from the `author` job of `gen.poc-loop.yml`. It writes the pair and
 * commits it; it never runs the program. Execution is the `execute` job's
 * work, and that job holds no credential precisely because it runs steps the
 * reporter described.
 */
import { readFileSync } from "node:fs"
import { askJson } from "./agent.ts"
import * as Github from "./github.ts"
import { maximumPocAttempts, pocMarker } from "./labels.ts"
import * as Repro from "./repro.ts"
import { commitPaths, isEntryPoint } from "./shell.ts"
import type { Comment, Report } from "./schema.ts"

/** What the agent is asked to produce. */
interface Draft {
  readonly claim: string
  readonly steps: ReadonlyArray<string>
  readonly expected: string
  readonly actual: string
  readonly program: string
}

const feedback = (comments: ReadonlyArray<Comment>): string => {
  const rejections = comments.filter((comment) => /^\s*(?:no|nope|not quite)\b/i.test(comment.body))
  return rejections.length === 0
    ? "There is no earlier feedback."
    : ["Earlier attempts were rejected. What the reporter said:", ...rejections.map((c) => `- ${c.body.slice(0, 2000)}`)]
      .join("\n")
}

const prompt = (report: Report, attempt: number, priorNotes: string, priorFeedback: string): string =>
  [
    "You are writing a minimal, runnable proof of concept for a bug report in `flows`, an",
    "Effect v4 coding-agent harness. The repository is checked out at the current directory.",
    "",
    "Answer with JSON only, no prose and no code fence:",
    '{"claim": "<one sentence>", "steps": ["<step>", ...], "expected": "<one sentence>",',
    ' "actual": "<one sentence>", "program": "<TypeScript source>"}',
    "",
    "`program` runs under `node <file>` on Node 22 with type stripping, so it may use TypeScript",
    "annotations but no enums, no namespaces, and no decorators. It must:",
    "- import only from `node:*` builtins and from this repository's packages,",
    "- exit non-zero, with a clear message, when the reported bug is present,",
    "- exit zero when it is absent,",
    "- do nothing to the machine it runs on beyond writing under the system temporary directory,",
    "- never reach the network.",
    "",
    "Reproduce what the reporter described, not what you think the underlying cause is. If the",
    "report is too vague to reproduce, write the smallest program that tests the single concrete",
    "claim it does make, and say so in `claim`.",
    "",
    `This is attempt ${String(attempt)} of at most ${String(maximumPocAttempts)}.`,
    "",
    `## The report (#${String(report.number)})`,
    "",
    `Title: ${report.title}`,
    "",
    report.body === "" ? "(no body)" : report.body,
    "",
    "## Earlier attempts",
    "",
    priorNotes === "" ? "There are none." : priorNotes,
    "",
    priorFeedback
  ].join("\n")

const main = (): void => {
  const number = Github.issueNumber()
  const report = Github.readIssue(number)
  const comments = Github.readComments(number)
  const attempt = Repro.nextAttempt(number)
  if (attempt > maximumPocAttempts) {
    console.log(`#${String(number)} has already used ${String(maximumPocAttempts)} attempts; not authoring another.`)
    return
  }

  // Earlier notes are on disk from earlier runs of this same job, committed
  // to the branch. Reading them beats asking the model to remember.
  const priorNotes = Repro.attempts(number)
    .map((earlier) => Repro.parseNote(readFileSync(Repro.notePath(number, earlier), "utf8")))
    .map((note) => `- attempt ${String(note.attempt)}: ${note.claim}`)
    .join("\n")

  const draft = askJson<Draft>({ prompt: prompt(report, attempt, priorNotes, feedback(comments)) })
  const repro: Repro.Repro = {
    issue: number,
    attempt,
    claim: draft.claim ?? "",
    steps: draft.steps ?? [],
    expected: draft.expected ?? "",
    actual: draft.actual ?? "",
    program: draft.program ?? ""
  }
  if (repro.program.trim() === "") throw new Error("the agent produced no program")
  Repro.write(repro)
  commitPaths(
    [Repro.directory(number)],
    `🧪 test(factory): add repro attempt ${String(attempt)} for #${String(number)}`
  )
  console.log(`${pocMarker} wrote ${Repro.programPath(number, attempt)}`)
}

if (isEntryPoint(import.meta.url)) main()
