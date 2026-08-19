/**
 * Running commands, and the git operations the automation performs.
 *
 * Everything here takes an argv array. Nothing builds a shell string, because
 * the values flowing through this module — branch names derived from issue
 * numbers, paths derived from labels — are close enough to reporter-controlled
 * text that a shell would be a hole.
 */
import { spawnSync } from "node:child_process"
import { pathToFileURL } from "node:url"

/** The largest captured output. */
export const maximumOutputBytes = 16 * 1024 * 1024

/** How much of a log a result carries. */
export const logTailBytes = 32 * 1024

/** What running one command produced. */
export interface Outcome {
  readonly ok: boolean
  readonly exitCode: number | null
  readonly output: string
}

/**
 * Runs one command and captures it.
 *
 * A non-zero exit is a value, not a throw. Every caller here is deciding
 * something about the failure, so making the normal case an exception would
 * put the interesting logic in a catch block.
 */
export const run = (
  command: string,
  argv: ReadonlyArray<string>,
  options: { readonly cwd?: string; readonly timeoutMs?: number; readonly env?: Record<string, string> } = {}
): Outcome => {
  const result = spawnSync(command, [...argv], {
    cwd: options.cwd,
    encoding: "utf8",
    maxBuffer: maximumOutputBytes,
    shell: false,
    timeout: options.timeoutMs,
    env: options.env === undefined ? process.env : { ...process.env, ...options.env }
  })
  if (result.error !== undefined) {
    return { ok: false, exitCode: null, output: result.error.message }
  }
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`
  return {
    ok: result.status === 0,
    exitCode: result.status,
    output: output.length <= logTailBytes ? output : output.slice(output.length - logTailBytes)
  }
}

/** Runs one command and throws when it fails. */
export const must = (
  command: string,
  argv: ReadonlyArray<string>,
  options: Parameters<typeof run>[2] = {}
): string => {
  const outcome = run(command, argv, options)
  if (!outcome.ok) {
    throw new Error(`${command} ${argv.join(" ")} exited with ${String(outcome.exitCode)}: ${outcome.output}`)
  }
  return outcome.output
}

/** Runs one git command. */
export const git = (argv: ReadonlyArray<string>, cwd?: string): string => must("git", argv, { cwd })

/**
 * The bot identity every automation commit is authored by.
 *
 * A distinct identity rather than the maintainer's, so a person reading the
 * history can tell at a glance which commits a human wrote.
 */
export const botName = "flows-factory[bot]"

/** The bot's commit email. */
export const botEmail = "flows-factory@users.noreply.github.com"

/** Configures the bot identity in one working tree. */
export const configureIdentity = (cwd?: string): void => {
  git(["config", "user.name", botName], cwd)
  git(["config", "user.email", botEmail], cwd)
}

/**
 * Commits the given paths, if any of them changed.
 *
 * Only the named paths. The tree an automation run works in is shared with
 * whatever the run itself built, so `git add -A` would sweep build output into
 * a bookkeeping commit.
 */
export const commitPaths = (
  paths: ReadonlyArray<string>,
  message: string,
  cwd?: string
): boolean => {
  if (paths.length === 0) return false
  const staged = run("git", ["add", "--", ...paths], { cwd })
  if (!staged.ok) return false
  const pending = run("git", ["diff", "--cached", "--quiet"], { cwd })
  if (pending.ok) return false
  configureIdentity(cwd)
  git(["commit", "-m", message], cwd)
  return true
}

/** The merge base of one ref against another. */
export const mergeBase = (left: string, right: string, cwd?: string): string =>
  git(["merge-base", left, right], cwd).trim()

/**
 * Whether this module is the process's entry point.
 *
 * Every automation entry guards its `main()` with it. Without the guard,
 * importing an entry to test one of its exported helpers would run the whole
 * thing, and the first thing most of them do is call GitHub.
 */
export const isEntryPoint = (metaUrl: string, argv: ReadonlyArray<string> = process.argv): boolean => {
  const entry = argv[1]
  if (entry === undefined) return false
  return metaUrl === pathToFileURL(entry).href
}
