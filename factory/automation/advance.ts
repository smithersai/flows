/**
 * Advance the repro state on a reporter's reply.
 *
 * Runs from `gen.issue-reply.yml` on `issue_comment: [created]`.
 *
 * Only the reporter's replies move the state. A comment from anyone else is
 * conversation: letting a third party confirm someone else's repro is how a
 * loop that asks a person a question stops being one.
 */
import { ask } from "./agent.ts"
import * as Github from "./github.ts"
import { isEntryPoint } from "./shell.ts"
import { attemptsFrom, pocMarker, readsAsConfirmation, readsAsRejection, transition } from "./labels.ts"
import * as Repro from "./repro.ts"
import type { Comment } from "./schema.ts"

/** How the reply reads. */
export type Reading = "confirm" | "reject" | "unclear"

/**
 * Reads one reply.
 *
 * The regular expressions decide the common case, which is the reporter
 * answering the yes/no question they were asked. The agent is consulted only
 * when they did not, and it is told to answer `unclear` when it is unsure:
 * asking again costs a comment, and guessing wrong marks a repro verified on
 * the strength of a thank-you note.
 */
export const read = (
  body: string,
  agent: (prompt: string) => string = (prompt) => ask({ prompt })
): Reading => {
  if (readsAsConfirmation(body)) return "confirm"
  if (readsAsRejection(body)) return "reject"
  const answer = agent(
    [
      "A bug reporter was asked: \"Does this proof of concept capture your issue?\"",
      "They replied with the text below. Answer with exactly one word: confirm, reject, or unclear.",
      "Answer `unclear` unless the reply plainly says yes or plainly says no. A reply that thanks,",
      "asks a question, or adds context without answering is `unclear`.",
      "",
      body.slice(0, 8000)
    ].join("\n")
  ).trim().toLowerCase()
  if (answer.startsWith("confirm")) return "confirm"
  if (answer.startsWith("reject")) return "reject"
  return "unclear"
}

const latestComment = (comments: ReadonlyArray<Comment>): Comment | undefined => comments.at(-1)

const main = (): void => {
  const number = Github.issueNumber()
  const report = Github.readIssue(number)
  if (!report.labels.includes("poc:proposed")) {
    console.log(`#${String(number)} has no proposed PoC awaiting a reply.`)
    return
  }
  const comments = Github.readComments(number)
  const reply = latestComment(comments)
  if (reply === undefined) return
  if (reply.body.includes(pocMarker)) {
    console.log("the latest comment is the proposal itself.")
    return
  }
  if (reply.author !== report.author) {
    console.log(`the latest comment is from ${reply.author}, not the reporter; the state does not move.`)
    return
  }

  const reading = read(reply.body)
  if (reading === "unclear") {
    Github.comment(
      number,
      [
        "Thanks. To move this along, one short answer helps:",
        "",
        "- reply starting with `yes` if the proof of concept above captures your issue,",
        "- reply starting with `no` plus what it is missing if it does not."
      ].join("\n")
    )
    console.log("the reply was unclear; asked again.")
    return
  }

  if (reading === "confirm") {
    const confirmed = transition({ kind: "reporter-confirmed" }, report.labels)
    Github.editLabels(number, confirmed.add, confirmed.remove)
    // Verification needs both halves. The confirmation is one; the sandbox's
    // recorded failure on main is the other.
    const attempt = Repro.attempts(number).at(-1)
    const result = attempt === undefined ? undefined : Repro.readResult(number, attempt)
    if (result?.failed === true) {
      const labels = [...report.labels, ...confirmed.add].filter((label) => !confirmed.remove.includes(label))
      const verified = transition({ kind: "poc-failed-on-main" }, labels)
      Github.editLabels(number, verified.add, verified.remove)
      Github.comment(number, `${confirmed.reason} ${verified.reason}`)
      console.log(verified.reason)
      return
    }
    Github.comment(number, `${confirmed.reason} The proof of concept does not yet fail on main, so a revision follows.`)
    console.log(confirmed.reason)
    return
  }

  const attempts = attemptsFrom(comments.map((comment) => comment.body))
  const rejected = transition({ kind: "reporter-rejected", attempts }, report.labels)
  Github.editLabels(number, rejected.add, rejected.remove)
  Github.comment(number, rejected.reason)
  console.log(rejected.reason)
}

if (isEntryPoint(import.meta.url)) main()
