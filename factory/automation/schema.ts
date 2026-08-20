/**
 * The door schema: an issue decoded once, at the edge, into a typed value.
 *
 * Everything downstream reads the decoded `Report`, never the raw payload.
 * That is the [[Input]] rule applied to GitHub: one schema, one decode, at the
 * door. It also bounds the blast radius of a hostile issue body, because the
 * fields the automation reads are the fields the schema kept, and each of them
 * is length-bounded before it reaches a prompt.
 *
 * There is no schema library here on purpose. `factory/automation/` runs from a
 * bare `node` on an Actions runner with only the workspace installed, and the
 * decode it needs is small enough that a dependency would cost more than it
 * saves.
 */

/** The largest issue body admitted to a prompt. */
export const maximumBodyLength = 64 * 1024

/** The largest title admitted. */
export const maximumTitleLength = 1024

/** The largest number of labels read from one issue. */
export const maximumLabels = 100

/** A decoded issue. */
export interface Report {
  readonly number: number
  readonly title: string
  readonly body: string
  readonly labels: ReadonlyArray<string>
  readonly state: "open" | "closed"
  readonly author: string
  readonly authorAssociation: string
}

/** A decoded comment. */
export interface Comment {
  readonly body: string
  readonly author: string
  readonly authorAssociation: string
  /** ISO 8601, or the empty string when the source did not carry one. */
  readonly createdAt: string
}

/** The decode refused the payload. */
export class DecodeError extends Error {
  override readonly name = "DecodeError"
}

const fail = (what: string): never => {
  throw new DecodeError(`the payload is not a usable issue: ${what}`)
}

const record = (value: unknown, what: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${what} is not an object`)
  return value as Record<string, unknown>
}

/**
 * Bounds one text field.
 *
 * Truncation is marked rather than silent. A prompt that ends mid-sentence
 * with no explanation reads to a model like the reporter stopped writing, and
 * the answer it produces is confidently about half a report.
 */
export const boundedText = (value: unknown, limit: number, what: string): string => {
  if (value === null || value === undefined) return ""
  if (typeof value !== "string") fail(`${what} is not text`)
  const text = value as string
  const wellFormed = text.isWellFormed() ? text : text.toWellFormed()
  return wellFormed.length <= limit
    ? wellFormed
    : `${wellFormed.slice(0, limit)}\n\n[truncated at ${String(limit)} characters by the factory decoder]`
}

/** Reads a label list in either the object or the plain-string form. */
export const decodeLabels = (value: unknown): ReadonlyArray<string> => {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) fail("labels is not a list")
  const labels: Array<string> = []
  for (const entry of (value as ReadonlyArray<unknown>).slice(0, maximumLabels)) {
    if (typeof entry === "string") {
      labels.push(entry)
      continue
    }
    const name = record(entry, "a label").name
    if (typeof name === "string") labels.push(name)
  }
  return labels
}

/**
 * Decodes one issue.
 *
 * Accepts both shapes the automation sees: the `issue` object of a webhook
 * payload and the object `gh issue view --json` prints. They agree on every
 * field read here except the author, which is `user.login` in one and
 * `author.login` in the other.
 */
export const decodeReport = (value: unknown): Report => {
  const issue = record(value, "the issue")
  const number = issue.number
  if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) fail("number is not a positive integer")
  const state = issue.state === "closed" || issue.state === "CLOSED" ? "closed" : "open"
  const user = issue.user ?? issue.author
  const author = user === undefined || user === null ? "" : boundedText(record(user, "the author").login, 128, "author")
  return {
    number: number as number,
    title: boundedText(issue.title, maximumTitleLength, "title"),
    body: boundedText(issue.body, maximumBodyLength, "body"),
    labels: decodeLabels(issue.labels),
    state,
    author,
    authorAssociation: boundedText(issue.author_association ?? issue.authorAssociation, 64, "author association")
  }
}

/** Decodes one comment. */
export const decodeComment = (value: unknown): Comment => {
  const comment = record(value, "the comment")
  const user = comment.user ?? comment.author
  return {
    body: boundedText(comment.body, maximumBodyLength, "body"),
    author: user === undefined || user === null ? "" : boundedText(record(user, "the author").login, 128, "author"),
    authorAssociation: boundedText(comment.author_association ?? comment.authorAssociation, 64, "author association"),
    createdAt: boundedText(comment.created_at ?? comment.createdAt, 64, "created at")
  }
}

/**
 * The repro key an issue is filed under.
 *
 * It is the issue number and nothing else. A content hash would look smarter
 * and be wrong: the same bug reported twice is two reports with two
 * conversations, and the dedupe pass is what links them.
 */
export const reproKey = (report: Report): string => `issue-${String(report.number)}`

/** The repro directory one report's proof of concept lives in. */
export const reproDirectory = (report: Report): string => `factory/repros/${String(report.number)}`
