/**
 * The issue-memory corpus: one markdown file per triaged issue.
 *
 * Presence is registration and the path is the name, the same doctrine the
 * queue uses. Intake reads the corpus to find duplicates and neighbours before
 * it searches GitHub, because the corpus already holds the judgment a previous
 * triage made and a search result does not.
 *
 * The format is frontmatter plus prose so a person can read it in an editor
 * and an agent can read it in a prompt, without either needing tooling. This
 * module is the only writer.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/** The corpus directory, relative to the repository root. */
export const memoryDirectory = "factory/memory"

/** The index file listing one line per entry. */
export const indexFile = "README.md"

/** One corpus entry. */
export interface Entry {
  readonly issue: number
  readonly title: string
  readonly labels: ReadonlyArray<string>
  readonly state: "open" | "closed"
  /** The repro key, when the issue has a proof of concept. */
  readonly reproKey?: string | undefined
  /** Related issue numbers, in either direction. */
  readonly related: ReadonlyArray<number>
  /** The compact summary. Prose, not a transcript. */
  readonly summary: string
}

/** The file one entry lives in. */
export const entryPath = (issue: number): string => join(memoryDirectory, `${String(issue)}.md`)

const quote = (value: string): string => JSON.stringify(value)

/**
 * Renders one entry.
 *
 * Every scalar is JSON-quoted. A title carrying a colon is common and would
 * otherwise produce frontmatter that neither Obsidian nor this module's own
 * reader can parse.
 */
export const render = (entry: Entry): string => {
  const lines = [
    "---",
    `issue: ${String(entry.issue)}`,
    `title: ${quote(entry.title)}`,
    `labels: [${entry.labels.map(quote).join(", ")}]`,
    `state: ${entry.state}`
  ]
  if (entry.reproKey !== undefined && entry.reproKey !== "") lines.push(`reproKey: ${quote(entry.reproKey)}`)
  lines.push(`related: [${entry.related.map((number) => String(number)).join(", ")}]`)
  lines.push("---", "", `# ${entry.title}`, "", entry.summary.trim(), "")
  return lines.join("\n")
}

const scalar = (value: string): string => {
  const trimmed = value.trim()
  if (trimmed.startsWith("\"")) {
    const parsed: unknown = JSON.parse(trimmed)
    if (typeof parsed === "string") return parsed
  }
  return trimmed
}

const list = (value: string): ReadonlyArray<string> => {
  const inner = value.trim().replace(/^\[/, "").replace(/\]$/, "").trim()
  if (inner === "") return []
  return inner.split(",").map((part) => scalar(part)).filter((part) => part !== "")
}

/**
 * Parses one entry.
 *
 * It refuses a file without frontmatter rather than inventing defaults. A
 * corpus entry the reader silently repaired is an entry whose dedupe answer no
 * longer matches what is on disk.
 */
export const parse = (source: string): Entry => {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source)
  if (match === null) throw new Error("a memory entry must open with YAML frontmatter")
  const fields = new Map<string, string>()
  for (const line of match[1]!.split("\n")) {
    const separator = line.indexOf(":")
    if (separator === -1) continue
    fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim())
  }
  const issue = Number(fields.get("issue"))
  if (!Number.isInteger(issue) || issue <= 0) throw new Error("a memory entry must name a positive issue number")
  const reproKey = fields.get("reproKey")
  // The rendered body opens with a level-one title repeating the frontmatter
  // title. Trimming first is what lets the heading be recognised at the start.
  const body = match[2]!.trim().replace(/^#[^\n]*\n+/, "").trim()
  return {
    issue,
    title: scalar(fields.get("title") ?? ""),
    labels: list(fields.get("labels") ?? "[]"),
    state: fields.get("state") === "closed" ? "closed" : "open",
    reproKey: reproKey === undefined ? undefined : scalar(reproKey),
    related: list(fields.get("related") ?? "[]").map(Number).filter((number) => Number.isInteger(number)),
    summary: body
  }
}

/** Reads every entry, ordered by issue number. */
export const readAll = (root = "."): ReadonlyArray<Entry> => {
  const directory = join(root, memoryDirectory)
  if (!existsSync(directory)) return []
  const entries: Array<Entry> = []
  for (const name of readdirSync(directory).sort()) {
    if (!/^[0-9]+\.md$/.test(name)) continue
    entries.push(parse(readFileSync(join(directory, name), "utf8")))
  }
  return entries.sort((left, right) => left.issue - right.issue)
}

/** Reads one entry, or `undefined` when the issue has never been triaged. */
export const read = (issue: number, root = "."): Entry | undefined => {
  const path = join(root, entryPath(issue))
  return existsSync(path) ? parse(readFileSync(path, "utf8")) : undefined
}

/**
 * Writes one entry and refreshes the index.
 *
 * The index is derived, never edited: rewriting it from the directory on every
 * write is what keeps it honest, and it is cheap at the size a repository's
 * triaged-issue corpus reaches.
 */
export const write = (entry: Entry, root = "."): void => {
  const directory = join(root, memoryDirectory)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(root, entryPath(entry.issue)), render(entry), "utf8")
  writeFileSync(join(directory, indexFile), renderIndex(readAll(root)), "utf8")
}

/**
 * The index file's text.
 *
 * The whole README is generated, prose included, rather than a hand-written
 * page with a generated table stitched into it. One writer means the page
 * cannot half-rot: a stitched table would drift from the prose above it the
 * first time the entry shape changed, and nothing would notice.
 *
 * @see {@link write}, the only caller.
 */
export const renderIndex = (entries: ReadonlyArray<Entry>): string =>
  [
    "# factory/memory/",
    "",
    "One markdown file per triaged issue. Presence is registration; the file name is",
    "the issue number. `factory/automation/intake.ts` reads this corpus for duplicates",
    "and neighbours before it searches GitHub, because the corpus holds the judgment a",
    "previous triage made and a search result does not.",
    "",
    "This page is generated. `factory/automation/memory.ts` rewrites it from the",
    "directory on every write, so do not edit it by hand; edit the renderer.",
    "",
    "## An entry",
    "",
    "```markdown",
    "---",
    "issue: 42",
    "title: \"Edit blocks: locating a block fails when the file uses CRLF\"",
    "labels: [\"repro:verified\", \"poc:confirmed\"]",
    "state: open",
    "reproKey: \"issue-42\"",
    "related: [7]",
    "---",
    "",
    "# Edit blocks: locating a block fails when the file uses CRLF",
    "",
    "Applying an edit block to a CRLF file reports no match. The locator normalises",
    "the search text but not the haystack.",
    "```",
    "",
    "| Field | Means |",
    "| ----- | ----- |",
    "| `issue` | The issue number. It is also the file name. |",
    "| `title` | The issue title at the time of the last triage. |",
    "| `labels` | The labels the issue carried after the triage that wrote this entry. |",
    "| `state` | `open` or `closed`. |",
    "| `reproKey` | `issue-<n>`, present once the issue has a proof of concept. |",
    "| `related` | Issue numbers linked in either direction, including a confirmed duplicate. |",
    "",
    "Every scalar is JSON-quoted, because issue titles carry colons routinely and",
    "unquoted frontmatter would not survive one.",
    "",
    "The body is a compact summary in prose: what breaks, and under what conditions.",
    "It is not a transcript of the issue, and it does not speculate about the cause.",
    "Automation runs append to it rather than replacing it, so an entry reads as the",
    "history of what triage learned.",
    "",
    "## Who writes here",
    "",
    "Only trusted, gated jobs. `intake.ts` writes the first entry, `poc-publish.ts`",
    "records the PoC outcome, and `reverify.ts` records a sweep's closure. Each commits",
    "its own change with a `\u{1F4DD} docs(factory):` message. The sandbox job that runs",
    "reporter-derived code holds no write permission and cannot reach this directory.",
    "",
    "## Entries",
    "",
    entries.length === 0 ? "No issues have been triaged yet." : "",
    entries.length === 0 ? "" : "| Issue | State | Labels | Title |",
    entries.length === 0 ? "" : "| ----- | ----- | ------ | ----- |",
    ...entries.map((entry) =>
      `| #${String(entry.issue)} | ${entry.state} | ${
        entry.labels.length === 0 ? "-" : entry.labels.join(", ")
      } | ${entry.title.replace(/\|/g, "\\|")} |`
    ),
    ""
  ].filter((line, index, all) => !(line === "" && all[index - 1] === "")).join("\n")

/**
 * Scores one entry against a report's title and body, for dedupe.
 *
 * Token overlap, deliberately. It is a first pass whose job is to hand the
 * agent a short candidate list, not to decide anything: a cheap, explainable
 * score that a person can reproduce beats a similarity model whose verdict
 * nobody can argue with.
 */
export const score = (entry: Entry, title: string, body: string): number => {
  const wanted = tokens(`${title} ${body}`)
  if (wanted.size === 0) return 0
  const have = tokens(`${entry.title} ${entry.summary}`)
  let shared = 0
  for (const token of wanted) if (have.has(token)) shared += 1
  return shared / wanted.size
}

const stopWords = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "when",
  "then",
  "have",
  "not",
  "but",
  "you",
  "are",
  "was",
  "were",
  "into",
  "does"
])

const tokens = (text: string): Set<string> => {
  const found = new Set<string>()
  for (const raw of text.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (raw.length < 3 || stopWords.has(raw)) continue
    found.add(raw)
  }
  return found
}

/** The best candidates for a report, most similar first. */
export const candidates = (
  entries: ReadonlyArray<Entry>,
  title: string,
  body: string,
  limit = 5
): ReadonlyArray<{ readonly entry: Entry; readonly score: number }> =>
  entries
    .map((entry) => ({ entry, score: score(entry, title, body) }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.entry.issue - right.entry.issue)
    .slice(0, limit)
