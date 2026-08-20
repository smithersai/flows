/**
 * The GitHub side: the event payload the run was triggered by, and a thin
 * wrapper over the `gh` CLI.
 *
 * `gh` rather than a REST client, because the runner already has it
 * authenticated from `GH_TOKEN` and because a shelled-out command is the same
 * command a maintainer can paste into a terminal to see what the automation
 * did. Every call goes through {@link gh}, so there is exactly one place that
 * decides how arguments reach the process: as an argv array, never a shell
 * string.
 */
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { decodeComment, decodeReport } from "./schema.ts"
import type { Comment, Report } from "./schema.ts"

/** The largest `gh` response this wrapper accepts. */
export const maximumResponseBytes = 16 * 1024 * 1024

/** A `gh` invocation failed. */
export class GhError extends Error {
  override readonly name = "GhError"
  readonly status: number | null

  constructor(argv: ReadonlyArray<string>, status: number | null, stderr: string) {
    super(`gh ${argv.join(" ")} exited with ${String(status)}: ${stderr.slice(0, 800)}`)
    this.status = status
  }
}

/**
 * Runs `gh` with an argv array.
 *
 * `shell` is never enabled. Issue titles and comment bodies reach this
 * function routinely, and a shell would turn a backtick in a bug report into a
 * command on the runner.
 */
export const gh = (argv: ReadonlyArray<string>, input?: string): string => {
  const result = spawnSync("gh", [...argv], {
    encoding: "utf8",
    input,
    maxBuffer: maximumResponseBytes,
    shell: false
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new GhError(argv, result.status, result.stderr ?? "")
  return result.stdout
}

/** Runs `gh` and parses its JSON output. */
export const ghJson = <A>(argv: ReadonlyArray<string>): A => JSON.parse(gh(argv)) as A

/** The repository the run belongs to, as `owner/name`. */
export const repository = (): string => {
  const value = process.env.GITHUB_REPOSITORY
  if (value === undefined || value === "") throw new Error("GITHUB_REPOSITORY is not set")
  return value
}

/** The webhook payload the run was triggered by, or `undefined` locally. */
export const event = (): Record<string, unknown> | undefined => {
  const path = process.env.GITHUB_EVENT_PATH
  if (path === undefined || path === "") return undefined
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
  return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : undefined
}

/**
 * The issue number this run is about.
 *
 * The event payload first, then `ISSUE_NUMBER`, which is how a local run or a
 * `workflow_dispatch` names its subject. Failing loudly beats defaulting,
 * because every write this module performs is addressed by this number.
 */
export const issueNumber = (): number => {
  const payload = event()
  const issue = payload?.issue ?? payload?.pull_request
  if (typeof issue === "object" && issue !== null) {
    const number = (issue as Record<string, unknown>).number
    if (typeof number === "number") return number
  }
  const fallback = Number(process.env.ISSUE_NUMBER)
  if (Number.isInteger(fallback) && fallback > 0) return fallback
  throw new Error("this run names no issue: no event payload and no ISSUE_NUMBER")
}

/** The pull request number this run is about. */
export const pullRequestNumber = (): number => {
  const payload = event()
  const pull = payload?.pull_request
  if (typeof pull === "object" && pull !== null) {
    const number = (pull as Record<string, unknown>).number
    if (typeof number === "number") return number
  }
  const fallback = Number(process.env.PR_NUMBER)
  if (Number.isInteger(fallback) && fallback > 0) return fallback
  throw new Error("this run names no pull request: no event payload and no PR_NUMBER")
}

/**
 * Reads one issue fresh from the API.
 *
 * The event payload is a snapshot from when the run was queued, and the
 * labels are exactly what a maintainer edits between queueing and running.
 * Every decision this automation makes therefore re-reads them.
 */
export const readIssue = (number: number): Report =>
  decodeReport(
    ghJson([
      "issue",
      "view",
      String(number),
      "--repo",
      repository(),
      "--json",
      "number,title,body,labels,state,author"
    ])
  )

/** Reads one issue's comments, oldest first. */
export const readComments = (number: number): ReadonlyArray<Comment> => {
  const payload = ghJson<{ readonly comments?: ReadonlyArray<unknown> }>([
    "issue",
    "view",
    String(number),
    "--repo",
    repository(),
    "--json",
    "comments"
  ])
  return (payload.comments ?? []).map(decodeComment)
}

/** Posts one comment. The body travels over stdin, never argv. */
export const comment = (number: number, body: string): void => {
  gh(["issue", "comment", String(number), "--repo", repository(), "--body-file", "-"], body)
}

/**
 * Applies one label edit.
 *
 * Adds and removes go in one call so a run that dies between them cannot leave
 * the issue in two states at once.
 */
export const editLabels = (
  number: number,
  add: ReadonlyArray<string>,
  remove: ReadonlyArray<string>
): void => {
  if (add.length === 0 && remove.length === 0) return
  const argv = ["issue", "edit", String(number), "--repo", repository()]
  for (const label of add) argv.push("--add-label", label)
  for (const label of remove) argv.push("--remove-label", label)
  gh(argv)
}

/** Searches issues in this repository. */
export const searchIssues = (query: string, limit = 10): ReadonlyArray<Report> =>
  ghJson<ReadonlyArray<unknown>>([
    "search",
    "issues",
    query,
    "--repo",
    repository(),
    "--limit",
    String(limit),
    "--json",
    "number,title,body,labels,state,author"
  ]).map(decodeReport)

/** Opens one issue and returns its number. */
export const createIssue = (title: string, body: string, labels: ReadonlyArray<string>): number => {
  const argv = ["issue", "create", "--repo", repository(), "--title", title, "--body-file", "-"]
  for (const label of labels) argv.push("--label", label)
  const url = gh(argv, body).trim()
  const number = Number(url.split("/").at(-1))
  if (!Number.isInteger(number) || number <= 0) throw new Error(`gh issue create printed no issue number: ${url}`)
  return number
}

/** Closes one issue with a comment. */
export const closeIssue = (number: number, body: string): void => {
  gh(["issue", "close", String(number), "--repo", repository(), "--comment", body])
}

/** Whether one issue is closed. */
export const isClosed = (number: number): boolean => readIssue(number).state === "closed"

/** The unified diff of one pull request. */
export const pullRequestDiff = (number: number): string =>
  gh(["pr", "diff", String(number), "--repo", repository()])

/** The files one pull request touches. */
export const pullRequestFiles = (number: number): ReadonlyArray<string> =>
  ghJson<{ readonly files?: ReadonlyArray<{ readonly path?: string }> }>([
    "pr",
    "view",
    String(number),
    "--repo",
    repository(),
    "--json",
    "files"
  ]).files?.map((file) => file.path ?? "").filter((path) => path !== "") ?? []

/** The body of one pull request. */
export const pullRequestBody = (number: number): string =>
  ghJson<{ readonly body?: string }>([
    "pr",
    "view",
    String(number),
    "--repo",
    repository(),
    "--json",
    "body"
  ]).body ?? ""

/** One inline review comment, anchored to a new-side line of the diff. */
export interface ReviewComment {
  readonly path: string
  readonly line: number
  readonly body: string
}

/**
 * Posts one pull-request review: a body plus inline comments.
 *
 * One review, not one comment per finding, so the author gets one
 * notification. The event is always `COMMENT`: an automation neither approves
 * nor blocks, it reports. Inline anchors must be new-side lines the diff
 * actually shows, or the API refuses the whole review; the caller filters
 * against the diff before calling.
 */
export const review = (number: number, body: string, comments: ReadonlyArray<ReviewComment>): void => {
  gh(
    [
      "api",
      "--method",
      "POST",
      `repos/${repository()}/pulls/${String(number)}/reviews`,
      "--input",
      "-"
    ],
    JSON.stringify({
      body,
      event: "COMMENT",
      comments: comments.map((comment) => ({
        path: comment.path,
        line: comment.line,
        side: "RIGHT",
        body: comment.body
      }))
    })
  )
}

/** Opens one pull request and returns its URL. */
export const createPullRequest = (
  head: string,
  title: string,
  body: string,
  labels: ReadonlyArray<string>
): string => {
  const argv = [
    "pr",
    "create",
    "--repo",
    repository(),
    "--base",
    "main",
    "--head",
    head,
    "--title",
    title,
    "--body-file",
    "-"
  ]
  for (const label of labels) argv.push("--label", label)
  return gh(argv, body).trim()
}
