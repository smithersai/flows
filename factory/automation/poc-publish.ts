/**
 * Post the sandbox's result and move the state labels.
 *
 * This job holds the credential; the sandbox that produced the result did not.
 * The split is the whole security design of the PoC loop, so this entry never
 * executes anything it reads. It formats, classifies, comments, and labels.
 */
import { readFileSync } from "node:fs"
import { blockerBody, blockerTitle, classify } from "./blockers.ts"
import * as Github from "./github.ts"
import { infrastructureLabel, pocMarker, transition } from "./labels.ts"
import * as Memory from "./memory.ts"
import * as Repro from "./repro.ts"
import { commitPaths, isEntryPoint } from "./shell.ts"

/** Finds the open blocker issue for one classification, if there is one. */
export const findBlocker = (summary: string): number | undefined => {
  const open = Github.searchIssues(`label:${infrastructureLabel} state:open`, 20)
  return open.find((issue) => issue.title.includes(summary))?.number
}

const main = (): void => {
  const number = Github.issueNumber()
  const attempt = Repro.attempts(number).at(-1)
  if (attempt === undefined) throw new Error(`no proof of concept is on disk for #${String(number)}`)
  const result = Repro.readResult(number, attempt)
  if (result === undefined) throw new Error(`the sandbox recorded no result for attempt ${String(attempt)}`)
  const note = Repro.parseNote(readFileSync(Repro.notePath(number, attempt), "utf8"))
  const program = readFileSync(Repro.programPath(number, attempt), "utf8")
  const report = Github.readIssue(number)

  // A failure that has nothing to do with the report never counts against the
  // reporter. It parks the report against a blocker issue and says so.
  const blocker = result.failed ? classify(result.log) : undefined
  if (blocker !== undefined && blocker.unrelated) {
    const existing = findBlocker(blocker.summary)
    const blockerIssue = existing ?? Github.createIssue(
      blockerTitle(blocker),
      blockerBody(blocker, result.log, [number]),
      [infrastructureLabel]
    )
    Github.comment(
      number,
      [
        `Reproduction is parked. The run failed for a reason unrelated to this report: ${blocker.summary}.`,
        "",
        `Tracked in #${String(blockerIssue)}. The scheduled sweep unparks this report when that issue closes.`,
        "",
        "This does not count against the report."
      ].join("\n")
    )
    const parked = transition({ kind: "blocked", blocker: `#${String(blockerIssue)}` }, report.labels)
    Github.editLabels(number, parked.add, parked.remove)
    recordMemory(number, report.title, [...report.labels, ...parked.add], [blockerIssue], parked.reason)
    console.log(parked.reason)
    return
  }

  Github.comment(
    number,
    Repro.proposalComment(
      {
        issue: number,
        attempt,
        claim: note.claim,
        steps: note.steps,
        expected: "",
        actual: "",
        program
      },
      result,
      pocMarker
    )
  )
  const edit = transition({ kind: "poc-proposed" }, report.labels)
  Github.editLabels(number, edit.add, edit.remove)
  recordMemory(
    number,
    report.title,
    [...report.labels, ...edit.add].filter((label) => !edit.remove.includes(label)),
    [],
    `${edit.reason} Attempt ${String(attempt)} ${result.failed ? "fails" : "passes"} on main.`
  )
  console.log(edit.reason)
}

const recordMemory = (
  issue: number,
  title: string,
  labels: ReadonlyArray<string>,
  related: ReadonlyArray<number>,
  summary: string
): void => {
  const existing = Memory.read(issue)
  Memory.write({
    issue,
    title,
    labels,
    state: "open",
    reproKey: `issue-${String(issue)}`,
    related: [...new Set([...(existing?.related ?? []), ...related])],
    summary: existing === undefined ? summary : `${existing.summary}\n\n${summary}`
  })
  commitPaths(
    [Memory.memoryDirectory],
    `📝 docs(factory): record the PoC outcome for #${String(issue)}`
  )
}

if (isEntryPoint(import.meta.url)) main()
