/**
 * Rubric review over a pull request diff, posted as one review.
 *
 * The rubrics are the three `lint/BUILD.ts` already runs on every diff plus a
 * correctness rubric, restated here because this entry reviews a pull request
 * diff rather than a working-tree diff and cannot go through `LlmLint`'s
 * target machinery from inside a workflow job. `LlmLint` keys on `gitDiff`, so
 * the two agree on what a rubric is and on what re-running one costs.
 *
 * Every finding must state a concrete failure scenario. A review comment that
 * says "consider extracting this" costs the author a read and teaches nothing;
 * one that says "with an empty array this throws" is worth interrupting them
 * for. Findings without a scenario are dropped before anything is posted.
 */
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { askJson } from "./agent.ts"
import * as Github from "./github.ts"
import { isEntryPoint } from "./shell.ts"

/** The largest diff admitted to one review. */
export const maximumDiffBytes = 512 * 1024

/**
 * Where verdicts are cached, keyed by diff digest.
 *
 * Under `.flows/`, the workspace cache directory, which is already gitignored.
 * A verdict is a function of the diff and the rubrics, so an unchanged push is
 * a cache hit and costs nothing, exactly as `LlmLint` keying on `gitDiff` does.
 */
export const cacheDirectory = ".flows/pr-review"

/** One rubric the diff is measured against. */
export interface Rubric {
  readonly name: string
  readonly rubric: string
}

/** One finding. */
export interface Finding {
  readonly file: string
  readonly line: number
  readonly severity: "info" | "warning" | "error"
  readonly message: string
  /** Concrete inputs or state, then the wrong output or crash. */
  readonly scenario: string
}

/**
 * The rubrics, in the order they are reported.
 *
 * Correctness comes first because it is the only one that can block a merge;
 * the three inherited from `lint/BUILD.ts` report at the severity that file
 * already gives them.
 */
export const rubrics: ReadonlyArray<Rubric> = [
  {
    name: "correctness",
    rubric: [
      "Report defects a reader can demonstrate:",
      "1. A code path that throws, returns the wrong value, or corrupts state for a specific input.",
      "2. An unhandled error channel: a promise without a rejection path, an Effect whose failure is",
      "   swallowed, a spawn whose non-zero exit is ignored.",
      "3. A concurrency hazard: a shared mutable value written from two fibers, a check-then-act on a",
      "   file, a cache read that races its own write.",
      "4. A boundary the change moved: an off-by-one, an empty collection, a null, an unbounded read.",
      "Do not report style, naming, or structure. Do not report a defect you cannot state inputs for."
    ].join("\n")
  },
  {
    name: "durable identity",
    rubric: [
      "1. An identity string passed to `Action.make`, `Flow.make`, a service tag, or a",
      "   `Schema.TaggedError` tag must equal the defining module path.",
      "2. A rename must rename the identity everywhere and leave no backwards-compatible alias.",
      "3. A change to a persisted schema, a table, or a stored column must add a NEW migration file.",
      "4. A change to a durable key, or to the material one hashes, is a replay and cache hazard."
    ].join("\n")
  },
  {
    name: "docs reference sync",
    rubric: [
      "1. A public export whose reference page still describes removed or changed behavior.",
      "2. A new public export absent from its package's reference page.",
      "3. A concept page contradicted by the change.",
      "Report against the stale documentation page, not the source file."
    ].join("\n")
  },
  {
    name: "jsdoc truthfulness",
    rubric: [
      "For each export whose body changed:",
      "1. JSDoc prose that describes the old behavior.",
      "2. A documented error channel that does not match the `Schema.TaggedError` union the code",
      "   can fail with.",
      "3. A documented default that does not match the code.",
      "4. `@since` on a NEW export that is not the current unreleased version."
    ].join("\n")
  }
]

const framing = [
  "You are reviewing a pull request diff in `flows`, an Effect v4 coding-agent harness written",
  "from scratch. Report only violations of the rubric below. Judgment calls the rubric does not",
  "cover are not findings. Prefer no finding over a speculative one.",
  "",
  "Answer with JSON only, no prose and no code fence:",
  '{"findings": [{"file": "<path>", "line": <number>, "severity": "info|warning|error",',
  ' "message": "<what is wrong>", "scenario": "<concrete inputs or state, then the wrong result>"}]}',
  "",
  "`scenario` is mandatory and must be concrete. \"could be a problem\" is not a scenario;",
  "\"with an empty `paths` array, `resolved[0]` is undefined and the reserved-root check passes\" is.",
  "A finding without a usable scenario is dropped, so do not emit one."
].join("\n")

/** Whether a finding states a scenario concrete enough to post. */
export const hasScenario = (finding: Finding): boolean =>
  typeof finding.scenario === "string" &&
  finding.scenario.trim().length >= 24 &&
  !/^(?:could|might|may|possibly|potentially)\b/i.test(finding.scenario.trim())

/** The cache key for one diff under one rubric set. */
export const digest = (diff: string): string =>
  createHash("sha256").update(diff).update(JSON.stringify(rubrics)).digest("hex")

/** Reads a cached verdict, or `undefined`. */
export const readCache = (key: string, root = "."): ReadonlyArray<Finding> | undefined => {
  const path = join(root, cacheDirectory, `${key}.json`)
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as ReadonlyArray<Finding> : undefined
}

/** Records a verdict. */
export const writeCache = (key: string, findings: ReadonlyArray<Finding>, root = "."): void => {
  mkdirSync(join(root, cacheDirectory), { recursive: true })
  writeFileSync(join(root, cacheDirectory, `${key}.json`), `${JSON.stringify(findings, undefined, 2)}\n`, "utf8")
}

/** Renders the review body. */
export const renderReview = (findings: ReadonlyArray<Finding>): string => {
  if (findings.length === 0) {
    return [
      "## Rubric review",
      "",
      `No findings across ${String(rubrics.length)} rubrics: ${
        rubrics.map((rubric) => rubric.name).join(", ")
      }.`,
      "",
      "Every rubric asks for a concrete failure scenario, so an empty review means none was found,",
      "not that none was looked for."
    ].join("\n")
  }
  const order = { error: 0, warning: 1, info: 2 }
  const sorted = [...findings].sort((left, right) =>
    order[left.severity] - order[right.severity] || left.file.localeCompare(right.file) || left.line - right.line
  )
  return [
    "## Rubric review",
    "",
    `${String(sorted.length)} finding${sorted.length === 1 ? "" : "s"} across ${
      String(rubrics.length)
    } rubrics. Each states the scenario it fails in.`,
    "",
    ...sorted.map((finding) =>
      [
        `### \`${finding.file}:${String(finding.line)}\` — ${finding.severity}`,
        "",
        finding.message.trim(),
        "",
        `**Fails when:** ${finding.scenario.trim()}`,
        ""
      ].join("\n")
    )
  ].join("\n")
}

const main = (): void => {
  const number = Github.pullRequestNumber()
  const raw = Github.pullRequestDiff(number)
  const diff = raw.length <= maximumDiffBytes
    ? raw
    : `${raw.slice(0, maximumDiffBytes)}\n[diff truncated at ${String(maximumDiffBytes)} bytes]`
  const key = digest(diff)
  const cached = readCache(key)
  if (cached !== undefined) {
    console.log(`cache hit for diff ${key.slice(0, 12)}; the verdict is unchanged.`)
    return
  }

  const findings: Array<Finding> = []
  for (const rubric of rubrics) {
    const answer = askJson<{ readonly findings?: ReadonlyArray<Finding> }>({
      prompt: [framing, "", `## Rubric: ${rubric.name}`, "", rubric.rubric, "", "## Diff", "", diff].join("\n")
    })
    for (const finding of answer.findings ?? []) {
      if (hasScenario(finding)) findings.push(finding)
    }
  }

  Github.review(number, renderReview(findings), findings.every((finding) => finding.severity !== "error"))
  writeCache(key, findings)
  console.log(`posted ${String(findings.length)} findings for #${String(number)}.`)
}

if (isEntryPoint(import.meta.url)) main()
