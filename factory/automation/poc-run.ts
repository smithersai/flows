/**
 * Run the latest proof of concept, in the sandbox.
 *
 * This is the one entry that executes reporter-derived steps, so its job is
 * declared `untrustedInput` in the root BUILD.ts and the renderer leaves it
 * with no credential, no write permission, and a checkout that persists none.
 * It therefore cannot talk to GitHub at all. It writes a result file, and the
 * gated `publish` job reads it.
 *
 * Keep it that way. Anything added here that needs a token belongs in
 * `poc-publish.ts` instead. It reads the event file directly rather than
 * through `github.ts`, so nothing in this entry's import graph can reach the
 * `gh` wrapper.
 */
import { readFileSync } from "node:fs"
import * as Repro from "./repro.ts"
import { isEntryPoint, run } from "./shell.ts"

/** How long one proof of concept may run. */
export const timeoutMs = 10 * 60 * 1000

/** The issue this sandbox run is about. */
export const subject = (env: NodeJS.ProcessEnv = process.env): number => {
  const fromEnv = Number(env.ISSUE_NUMBER)
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv
  const payload = env.GITHUB_EVENT_PATH
  if (payload !== undefined && payload !== "") {
    const parsed: unknown = JSON.parse(readFileSync(payload, "utf8"))
    const issue = (parsed as { readonly issue?: { readonly number?: number } }).issue
    if (typeof issue?.number === "number") return issue.number
  }
  throw new Error("the sandbox names no issue: no ISSUE_NUMBER and no event payload")
}

const main = (): void => {
  const issue = subject()
  const attempt = Repro.attempts(issue).at(-1)
  if (attempt === undefined) throw new Error(`no proof of concept is on disk for #${String(issue)}`)
  const outcome = run("node", [Repro.programPath(issue, attempt)], { timeoutMs })
  Repro.writeResult({
    issue,
    attempt,
    // A non-zero exit is the bug being present. That is the whole verdict this
    // job produces. Whether it counts as a reproduction is decided by the
    // publishing job, which can also see whether the reporter confirmed it.
    failed: !outcome.ok,
    exitCode: outcome.exitCode,
    log: outcome.output
  })
  console.log(`attempt ${String(attempt)} for #${String(issue)} exited ${String(outcome.exitCode)}`)
}

if (isEntryPoint(import.meta.url)) main()
