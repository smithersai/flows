/**
 * The proof-of-concept pair: one `.md` beside one `.ts`, under
 * `factory/repros/<issue>/`.
 *
 * The shape is copied from `apps/ui/canary-repros/`, which already proved it:
 * the markdown is what a person reads and the TypeScript is what a machine
 * runs, and keeping them adjacent means neither can quietly stop describing
 * the other. A repro that lands as a fix's regression test is this exact file,
 * moved, not rewritten.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/** The directory every repro pair lives under. */
export const reprosDirectory = "factory/repros"

/** One proof-of-concept pair. */
export interface Repro {
  /** The issue this reproduces. */
  readonly issue: number
  /** The attempt number, starting at 1. */
  readonly attempt: number
  /** One sentence: what the reporter says goes wrong. */
  readonly claim: string
  /** The steps, in prose, as the reporter described them. */
  readonly steps: ReadonlyArray<string>
  /** What the program should do. */
  readonly expected: string
  /** What it does instead. */
  readonly actual: string
  /** The runnable TypeScript. It exits non-zero when the bug is present. */
  readonly program: string
}

/** The result of running one repro. */
export interface Result {
  readonly issue: number
  readonly attempt: number
  /** Whether the program failed, which is what a present bug looks like. */
  readonly failed: boolean
  /** The process exit code, or `null` when it was killed. */
  readonly exitCode: number | null
  /** The combined output, tail-bounded. */
  readonly log: string
}

/** The directory one issue's repros live in. */
export const directory = (issue: number): string => join(reprosDirectory, String(issue))

/** The markdown half of one attempt. */
export const notePath = (issue: number, attempt: number): string =>
  join(directory(issue), `attempt-${String(attempt)}.md`)

/** The runnable half of one attempt. */
export const programPath = (issue: number, attempt: number): string =>
  join(directory(issue), `attempt-${String(attempt)}.ts`)

/** Where the sandbox writes what it observed. */
export const resultPath = (issue: number, attempt: number): string =>
  join(directory(issue), `attempt-${String(attempt)}.result.json`)

/**
 * Renders the markdown half.
 *
 * It states the claim, the steps, and both outcomes, in that order, because
 * that is the order the reporter is asked to check them in. The question at
 * the end is the whole point of the loop: the pair is a hypothesis until a
 * person says it is their bug.
 */
export const renderNote = (repro: Repro): string =>
  [
    `# Repro for #${String(repro.issue)}, attempt ${String(repro.attempt)}`,
    "",
    repro.claim.trim(),
    "",
    "## Steps",
    "",
    ...repro.steps.map((step, index) => `${String(index + 1)}. ${step.trim()}`),
    "",
    "## Expected",
    "",
    repro.expected.trim(),
    "",
    "## Actual",
    "",
    repro.actual.trim(),
    "",
    "## Running it",
    "",
    "```sh",
    `node ${programPath(repro.issue, repro.attempt)}`,
    "```",
    "",
    "A non-zero exit means the bug is present.",
    ""
  ].join("\n")

/**
 * Parses the markdown half back.
 *
 * The parser exists so a later attempt can read what the earlier one claimed
 * without asking the model to remember. It reads only the fields it wrote.
 */
export const parseNote = (source: string): Pick<Repro, "issue" | "attempt" | "claim" | "steps"> => {
  const heading = /^# Repro for #(\d+), attempt (\d+)\s*$/m.exec(source)
  if (heading === null) throw new Error("a repro note must open with its issue and attempt heading")
  const claim = /^# [^\n]*\n\n([\s\S]*?)\n\n## Steps/.exec(source)
  const stepsBlock = /## Steps\n\n([\s\S]*?)\n\n## Expected/.exec(source)
  return {
    issue: Number(heading[1]),
    attempt: Number(heading[2]),
    claim: claim === null ? "" : claim[1]!.trim(),
    steps: stepsBlock === null ? [] : stepsBlock[1]!.split("\n").map((line) => line.replace(/^\d+\.\s*/, "").trim())
      .filter((line) => line !== "")
  }
}

/** Writes both halves of one attempt. */
export const write = (repro: Repro, root = "."): void => {
  mkdirSync(join(root, directory(repro.issue)), { recursive: true })
  writeFileSync(join(root, notePath(repro.issue, repro.attempt)), renderNote(repro), "utf8")
  writeFileSync(join(root, programPath(repro.issue, repro.attempt)), repro.program, "utf8")
}

/** The attempt numbers already on disk for one issue, ascending. */
export const attempts = (issue: number, root = "."): ReadonlyArray<number> => {
  const path = join(root, directory(issue))
  if (!existsSync(path)) return []
  return readdirSync(path)
    .map((name) => /^attempt-(\d+)\.ts$/.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]))
    .sort((left, right) => left - right)
}

/** The next attempt number for one issue. */
export const nextAttempt = (issue: number, root = "."): number => {
  const existing = attempts(issue, root)
  return existing.length === 0 ? 1 : existing[existing.length - 1]! + 1
}

/** Reads one recorded result. */
export const readResult = (issue: number, attempt: number, root = "."): Result | undefined => {
  const path = join(root, resultPath(issue, attempt))
  if (!existsSync(path)) return undefined
  return JSON.parse(readFileSync(path, "utf8")) as Result
}

/** Records one result. */
export const writeResult = (result: Result, root = "."): void => {
  mkdirSync(join(root, directory(result.issue)), { recursive: true })
  writeFileSync(
    join(root, resultPath(result.issue, result.attempt)),
    `${JSON.stringify(result, undefined, 2)}\n`,
    "utf8"
  )
}

/** The comment body that puts one attempt in front of the reporter. */
export const proposalComment = (repro: Repro, result: Result, marker: string): string =>
  [
    marker,
    `## Proof of concept for this report (attempt ${String(repro.attempt)})`,
    "",
    repro.claim.trim(),
    "",
    result.failed
      ? "It **fails on `main`** as written, which is what a present bug looks like."
      : "It **passes on `main`** as written, so it does not yet reproduce what you described.",
    "",
    "<details><summary>The program</summary>",
    "",
    "```ts",
    repro.program.trim(),
    "```",
    "",
    "</details>",
    "",
    "<details><summary>Output</summary>",
    "",
    "```",
    result.log.trim(),
    "```",
    "",
    "</details>",
    "",
    "**Does this capture your issue?** Reply to this comment.",
    "Start with `yes` if it does, or `no` plus what is missing if it does not.",
    ""
  ].join("\n")
