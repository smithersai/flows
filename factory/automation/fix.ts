/**
 * A verified repro becomes a queue item, a lane, and a pull request.
 *
 * Runs from `gen.verified-fix.yml`. It is the only automation that opens a
 * pull request, so it re-reads the issue's labels rather than trusting the
 * event payload, and it stops unless BOTH `repro:verified` and the maintainer
 * approval label are on the issue right now.
 *
 * It never pushes to `main`. The lane branch and the pull request are the
 * whole output; a person merges.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { ask } from "./agent.ts"
import * as Github from "./github.ts"
import { approvalLabel } from "./labels.ts"
import * as Queue from "./queue.ts"
import * as Repro from "./repro.ts"
import { commitPaths, git, isEntryPoint, must, run } from "./shell.ts"

/** The branch one issue's fix lane uses. */
export const laneBranch = (issue: number): string => `factory/fix-${String(issue)}`

/** The pull-request body, which carries the evidence the proof gate reads. */
export const pullRequestBody = (options: {
  readonly issue: number
  readonly claim: string
  readonly program: string
  readonly note: string
  readonly log: string
}): string =>
  [
    `Closes #${String(options.issue)}.`,
    "",
    options.claim.trim(),
    "",
    "## Evidence",
    "",
    `The proof of concept is \`${options.program}\`. It was confirmed by the reporter and fails on`,
    "`main`. The proof-gate check on this pull request re-runs it at the merge base and at the head,",
    "so the claim and the evidence cannot drift apart.",
    "",
    "<details><summary>The repro note</summary>",
    "",
    options.note.trim(),
    "",
    "</details>",
    "",
    "<details><summary>The failing run on main</summary>",
    "",
    "```",
    options.log.trim(),
    "```",
    "",
    "</details>",
    "",
    "The repro lands as a permanent regression test in the affected package's suite.",
    ""
  ].join("\n")

const main = (): void => {
  const number = Github.issueNumber()
  const report = Github.readIssue(number)
  if (!report.labels.includes("repro:verified")) {
    console.log(`#${String(number)} is not repro:verified; nothing to do.`)
    return
  }
  if (!report.labels.includes(approvalLabel)) {
    console.log(`#${String(number)} is verified but not \`${approvalLabel}\`; a maintainer opens the gate.`)
    return
  }
  const attempt = Repro.attempts(number).at(-1)
  if (attempt === undefined) throw new Error(`#${String(number)} is verified but carries no repro on disk`)
  const program = Repro.programPath(number, attempt)
  const note = readFileSync(Repro.notePath(number, attempt), "utf8")
  const parsed = Repro.parseNote(note)
  const result = Repro.readResult(number, attempt)

  const branch = laneBranch(number)
  git(["fetch", "origin", "main"])
  git(["checkout", "-B", branch, "origin/main"])

  const item = Queue.itemPath(number, report.title)
  writeFileSync(
    item,
    Queue.render({
      issue: number,
      title: report.title,
      labels: report.labels,
      reproProgram: program,
      claim: parsed.claim
    }),
    "utf8"
  )
  commitPaths([item, Repro.directory(number)], `📋 chore(factory): queue the fix for #${String(number)}`)

  // The lane's implementation runs through the agent seam with the queue item
  // as its prompt. It is the same prompt a human operator would hand the
  // factory, which is the point: the automation adds the trigger, not a
  // second, divergent instruction set.
  const answer = ask({
    prompt: [
      "You are implementing one item from the flows software factory queue, in a worktree already",
      "based on `origin/main`. Read the item below, make the change, and land the repro as a",
      "permanent regression test in the affected package's suite.",
      "",
      "Run the affected package's `check`, `lint`, and `test` scripts before you finish. Answer with",
      "a one-paragraph summary of what you changed and why.",
      "",
      readFileSync(item, "utf8")
    ].join("\n"),
    timeoutMs: 90 * 60 * 1000,
    // The lane's whole job is editing the tree and running the verification
    // scripts, which print mode cannot ask permission for. The job is behind
    // the maintainer gate and the commit below is path-scoped.
    tools: "workspace"
  })

  const dirty = run("git", ["status", "--porcelain"])
  if (dirty.output.trim() === "") {
    Github.comment(number, "The fix lane produced no change. A maintainer takes it from here.")
    console.log("the lane produced no change.")
    return
  }
  // Only the paths the lane was allowed to touch. A blanket add would sweep in
  // whatever the verification runs built.
  const changed = git(["diff", "--name-only"]).split("\n").map((line) => line.trim()).filter((line) => line !== "")
  commitPaths(changed, `🔧 fix(factory): resolve #${String(number)}\n\n${answer.trim()}`)
  must("git", ["push", "--force-with-lease", "origin", branch])

  const url = Github.createPullRequest(
    branch,
    `🔧 fix: ${report.title}`,
    pullRequestBody({
      issue: number,
      claim: parsed.claim,
      program,
      note,
      log: result?.log ?? "the failing run was not recorded"
    }),
    []
  )
  Github.comment(number, `A fix is up for review: ${url}`)
  console.log(url)
}

if (isEntryPoint(import.meta.url)) main()
