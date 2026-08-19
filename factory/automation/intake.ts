/**
 * Intake: decode a new report, look for duplicates, comment with candidates.
 *
 * Runs from `gen.issue-intake.yml` on `issues: [opened, edited]`, and locally
 * with `ISSUE_NUMBER=<n> node factory/automation/intake.ts`.
 *
 * The dedupe pass is two-stage on purpose. Token overlap against the memory
 * corpus and a `gh search issues` query are cheap and explainable, and they
 * produce a short candidate list; the agent is asked one question about that
 * list, which is the only part that needs judgment. Asking a model to search
 * would be slower, less repeatable, and no better.
 */
import { askJson } from "./agent.ts"
import * as Github from "./github.ts"
import { duplicateLabel, transition } from "./labels.ts"
import * as Memory from "./memory.ts"
import { commitPaths, isEntryPoint } from "./shell.ts"
import type { Report } from "./schema.ts"

/** The agent's verdict on the candidate list. */
interface Verdict {
  /** The issue number this report duplicates, or null. */
  readonly duplicateOf: number | null
  /** Related but distinct issues worth linking. */
  readonly related: ReadonlyArray<number>
  /** A compact summary of the report, for the memory corpus. */
  readonly summary: string
}

/** The search terms one report contributes to a `gh search issues` query. */
export const searchTerms = (report: Report, limit = 6): ReadonlyArray<string> => {
  const seen = new Set<string>()
  const terms: Array<string> = []
  for (const raw of report.title.split(/[^A-Za-z0-9_]+/)) {
    const term = raw.toLowerCase()
    if (term.length < 4 || seen.has(term)) continue
    seen.add(term)
    terms.push(term)
    if (terms.length === limit) break
  }
  return terms
}

const candidateBlock = (
  corpus: ReadonlyArray<{ readonly entry: Memory.Entry; readonly score: number }>,
  searched: ReadonlyArray<Report>
): string =>
  [
    "Candidates from the triaged-issue corpus:",
    ...corpus.map((candidate) =>
      `- #${String(candidate.entry.issue)} (${candidate.score.toFixed(2)}) ${candidate.entry.title}\n  ${
        candidate.entry.summary.slice(0, 400)
      }`
    ),
    corpus.length === 0 ? "- none" : "",
    "",
    "Candidates from issue search:",
    ...searched.map((issue) => `- #${String(issue.number)} [${issue.state}] ${issue.title}`),
    searched.length === 0 ? "- none" : ""
  ].filter((line) => line !== "").join("\n")

const prompt = (report: Report, candidates: string): string =>
  [
    "You are triaging a bug report for `flows`, an Effect v4 coding-agent harness.",
    "",
    "Decide three things and answer with JSON only, no prose and no code fence:",
    '{"duplicateOf": <issue number or null>, "related": [<issue numbers>], "summary": "<2-4 sentences>"}',
    "",
    "`duplicateOf` is a number ONLY when the candidate describes the same defect with the same",
    "cause. A report about the same file, the same feature, or the same error message is related,",
    "not a duplicate. When you are unsure, answer null: a wrong duplicate closes a real report.",
    "",
    "`summary` is for a triage corpus. State what breaks and under what conditions. Do not",
    "restate the title and do not speculate about the cause.",
    "",
    `## The report (#${String(report.number)})`,
    "",
    `Title: ${report.title}`,
    "",
    report.body === "" ? "(no body)" : report.body,
    "",
    "## Candidates",
    "",
    candidates
  ].join("\n")

const main = (): void => {
  const number = Github.issueNumber()
  const report = Github.readIssue(number)
  if (report.state === "closed") {
    console.log(`#${String(number)} is closed; intake has nothing to do.`)
    return
  }

  const corpus = Memory.readAll()
  const fromCorpus = Memory.candidates(corpus.filter((entry) => entry.issue !== number), report.title, report.body)
  const terms = searchTerms(report)
  const searched = terms.length === 0
    ? []
    : Github.searchIssues(terms.join(" "), 10).filter((issue) => issue.number !== number)

  const verdict = askJson<Verdict>({ prompt: prompt(report, candidateBlock(fromCorpus, searched)) })
  const duplicate = typeof verdict.duplicateOf === "number" && verdict.duplicateOf !== number
    ? verdict.duplicateOf
    : undefined
  const related = (verdict.related ?? []).filter((entry) => Number.isInteger(entry) && entry !== number)

  const lines = [
    duplicate === undefined
      ? "Triage found no strong duplicate."
      : `This looks like a duplicate of #${String(duplicate)}. A maintainer confirms or removes the \`${duplicateLabel}\` label.`,
    ""
  ]
  if (related.length > 0) {
    lines.push(`Related: ${related.map((entry) => `#${String(entry)}`).join(", ")}.`, "")
  }
  if (fromCorpus.length > 0) {
    lines.push(
      "Nearest triaged reports:",
      ...fromCorpus.map((candidate) => `- #${String(candidate.entry.issue)} ${candidate.entry.title}`),
      ""
    )
  }
  Github.comment(number, lines.join("\n"))

  const edit = transition({ kind: "intake", strongDuplicate: duplicate !== undefined }, report.labels)
  Github.editLabels(number, edit.add, edit.remove)

  Memory.write({
    issue: number,
    title: report.title,
    labels: [...report.labels, ...edit.add].filter((label) => !edit.remove.includes(label)),
    state: report.state,
    related: duplicate === undefined ? related : [duplicate, ...related],
    summary: verdict.summary ?? ""
  })
  commitPaths(
    [Memory.memoryDirectory],
    `📝 docs(factory): record the triage of #${String(number)} in the issue memory`
  )
  console.log(edit.reason)
}

if (isEntryPoint(import.meta.url)) main()
