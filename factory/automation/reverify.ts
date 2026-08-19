/**
 * The scheduled sweep: unpark blocked repros, re-run verified ones, close the
 * ones that no longer reproduce.
 *
 * Runs from `gen.repro-reverify.yml` on a daily schedule. A schedule has no
 * untrusted actor, so this is the one automation job without a gate.
 *
 * It exists because both of the states it touches rot silently. A report
 * parked on a blocker stays parked forever if nobody re-checks the blocker,
 * and a verified repro that someone fixed incidentally stays open forever
 * because nobody re-runs it. Neither failure is visible from the issue list.
 */
import * as Github from "./github.ts"
import { transition } from "./labels.ts"
import * as Memory from "./memory.ts"
import * as Repro from "./repro.ts"
import { commitPaths, isEntryPoint, pushMain, run } from "./shell.ts"

/** How long one repro may run during a sweep. */
export const timeoutMs = 10 * 60 * 1000

/** How long a `repro:needs-info` report waits before it is closed as stale. */
export const staleAfterDays = 21

/** The blocker issues one report's comments point at. */
export const blockersOf = (bodies: ReadonlyArray<string>): ReadonlyArray<number> => {
  const found = new Set<number>()
  for (const body of bodies) {
    if (!body.includes("Reproduction is parked")) continue
    const match = /Tracked in #(\d+)/.exec(body)
    if (match !== null) found.add(Number(match[1]))
  }
  return [...found]
}

const unpark = (issue: number): void => {
  const report = Github.readIssue(issue)
  const comments = Github.readComments(issue).map((comment) => comment.body)
  const blockers = blockersOf(comments)
  if (blockers.length === 0) return
  const open = blockers.filter((blocker) => !Github.isClosed(blocker))
  if (open.length > 0) {
    console.log(`#${String(issue)} stays parked on ${open.map((n) => `#${String(n)}`).join(", ")}.`)
    return
  }
  const edit = transition({ kind: "blocker-cleared" }, report.labels)
  Github.editLabels(issue, edit.add, edit.remove)
  Github.comment(
    issue,
    [
      `Every blocker this report was parked on is closed (${blockers.map((n) => `#${String(n)}`).join(", ")}).`,
      "",
      "Reproduction is unparked and resumes on the next PoC run."
    ].join("\n")
  )
  console.log(edit.reason)
}

const recheck = (issue: number): void => {
  const attempt = Repro.attempts(issue).at(-1)
  if (attempt === undefined) {
    console.log(`#${String(issue)} is verified but carries no repro on disk; skipping.`)
    return
  }
  const outcome = run("node", [Repro.programPath(issue, attempt)], { timeoutMs })
  Repro.writeResult({ issue, attempt, failed: !outcome.ok, exitCode: outcome.exitCode, log: outcome.output })
  if (!outcome.ok) {
    console.log(`#${String(issue)} still reproduces on main.`)
    return
  }
  const report = Github.readIssue(issue)
  const edit = transition({ kind: "no-longer-reproduces" }, report.labels)
  Github.editLabels(issue, edit.add, edit.remove)
  Github.closeIssue(
    issue,
    [
      "The confirmed reproduction for this report no longer fails on `main`.",
      "",
      `\`${Repro.programPath(issue, attempt)}\` exited 0 on the scheduled sweep. The evidence:`,
      "",
      "```",
      outcome.output.trim().slice(-4000),
      "```",
      "",
      "Reopen if it comes back; the repro stays in the tree either way."
    ].join("\n")
  )
  const existing = Memory.read(issue)
  Memory.write({
    issue,
    title: report.title,
    labels: report.labels.filter((label) => !edit.remove.includes(label)),
    state: "closed",
    reproKey: `issue-${String(issue)}`,
    related: existing?.related ?? [],
    summary: `${existing?.summary ?? ""}\n\nClosed by the scheduled sweep: the repro no longer fails on main.`.trim()
  })
  console.log(edit.reason)
}

/** Whether a report has been quiet long enough to close as stale. */
export const isStale = (lastActivity: string, now: number, days = staleAfterDays): boolean => {
  const at = Date.parse(lastActivity)
  if (Number.isNaN(at)) return false
  return now - at >= days * 24 * 60 * 60 * 1000
}

const stale = (issue: number, now: number): void => {
  const comments = Github.readComments(issue)
  const last = comments.at(-1)
  if (last === undefined || !isStale(last.createdAt, now)) return
  Github.closeIssue(
    issue,
    [
      `This report has been awaiting information for more than ${String(staleAfterDays)} days.`,
      "",
      "Closing it keeps the queue honest. Reply with what was asked and reopen; nothing is lost,",
      "and the triage record stays in `factory/memory/`."
    ].join("\n")
  )
  console.log(`#${String(issue)} closed as stale.`)
}

const main = (): void => {
  const now = Date.now()
  for (const report of Github.searchIssues("label:repro:blocked state:open", 50)) unpark(report.number)
  for (const report of Github.searchIssues("label:repro:verified state:open", 50)) recheck(report.number)
  for (const report of Github.searchIssues("label:repro:needs-info state:open", 50)) stale(report.number, now)
  const committed = commitPaths(
    [Memory.memoryDirectory, Repro.reprosDirectory],
    "📝 docs(factory): record the scheduled repro sweep"
  )
  if (committed) pushMain()
}

if (isEntryPoint(import.meta.url)) main()
