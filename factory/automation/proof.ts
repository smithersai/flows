/**
 * The proof gate: a fix must make a failing repro pass.
 *
 * Runs from `gen.repro-proof.yml` on pull requests that claim to close an
 * issue. The claim and the evidence must agree: the pull request's new or
 * changed repro program has to FAIL at the merge base and PASS at the head. A
 * fix whose test passes at the merge base tested nothing.
 *
 * The job is `untrustedInput`, so this entry holds no credential and posts
 * nothing. Its exit code is the check result, which is the only channel a
 * required check needs.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import * as Repro from "./repro.ts"
import { git, isEntryPoint, mergeBase, run } from "./shell.ts"

/** How long one repro program may run on either side. */
export const timeoutMs = 10 * 60 * 1000

/** The issues a pull-request body claims to close. */
export const claimedIssues = (body: string): ReadonlyArray<number> => {
  const found = new Set<number>()
  const pattern = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi
  let match = pattern.exec(body)
  while (match !== null) {
    found.add(Number(match[1]))
    match = pattern.exec(body)
  }
  return [...found].sort((left, right) => left - right)
}

/** The repro programs a diff touched, for the issues it claims. */
export const touchedPrograms = (
  files: ReadonlyArray<string>,
  issues: ReadonlyArray<number>
): ReadonlyArray<string> =>
  files.filter((path) =>
    issues.some((issue) => path.startsWith(`${Repro.directory(issue)}/`)) && path.endsWith(".ts")
  )

/**
 * Runs one program at one revision, in a detached worktree.
 *
 * A worktree rather than a checkout, because the head's `node_modules` is
 * already installed and a checkout would throw it away. The program itself
 * comes from the HEAD side either way: the point of the base run is to show
 * that the head's test fails against the base's code.
 */
export const runAt = (
  revision: string,
  program: string,
  workspace: string
): { readonly ok: boolean; readonly output: string } => {
  git(["worktree", "add", "--detach", workspace, revision])
  try {
    const target = join(workspace, program)
    if (!existsSync(target)) {
      // The base does not carry the repro, which is the normal shape of a fix
      // that adds one. Copy the head's program in so the base is measured
      // against the same test.
      const source = readFileSync(program, "utf8")
      mkdirSync(join(workspace, program, ".."), { recursive: true })
      writeFileSync(target, source, "utf8")
    }
    const outcome = run("node", [program], { cwd: workspace, timeoutMs })
    return { ok: outcome.ok, output: outcome.output }
  } finally {
    run("git", ["worktree", "remove", "--force", workspace])
  }
}

const main = (): void => {
  const body = process.env.PR_BODY ?? readEventBody()
  const issues = claimedIssues(body)
  if (issues.length === 0) {
    console.log("this pull request claims to close no issue; the proof gate does not apply.")
    return
  }
  const base = process.env.PR_BASE_SHA ?? mergeBase("HEAD", "origin/main")
  const changed = git(["diff", "--name-only", `${base}...HEAD`]).split("\n").map((line) => line.trim()).filter((
    line
  ) => line !== "")
  // A touched path that no longer exists at the head is a move: the repro
  // went into a package suite. The permanent test proves the fix there;
  // the gate has nothing left to run for that path.
  const programs = touchedPrograms(changed, issues).filter((program) => existsSync(program))
  if (programs.length === 0) {
    console.error(
      `this pull request claims ${issues.map((issue) => `#${String(issue)}`).join(", ")} but touches no repro under ${
        issues.map((issue) => Repro.directory(issue)).join(", ")
      }.`
    )
    console.error("A fix lands its repro as a permanent regression test. Add the repro, or drop the claim.")
    process.exitCode = 1
    return
  }

  let failures = 0
  for (const program of programs) {
    const atBase = runAt(base, program, ".proof-base")
    const atHead = run("node", [program], { timeoutMs })
    if (atBase.ok) {
      console.error(`${program} PASSES at the merge base ${base}. It proves nothing about this fix.`)
      console.error(atBase.output)
      failures += 1
      continue
    }
    if (!atHead.ok) {
      console.error(`${program} still FAILS at the head. The fix does not fix it.`)
      console.error(atHead.output)
      failures += 1
      continue
    }
    console.log(`${program}: fails at ${base}, passes at HEAD.`)
  }
  if (failures > 0) process.exitCode = 1
}

const readEventBody = (): string => {
  const path = process.env.GITHUB_EVENT_PATH
  if (path === undefined || path === "") return ""
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
  return (parsed as { readonly pull_request?: { readonly body?: string } }).pull_request?.body ?? ""
}

if (isEntryPoint(import.meta.url)) main()
