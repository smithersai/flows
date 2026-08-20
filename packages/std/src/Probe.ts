/**
 * Telling an invalid probe from a failing check.
 *
 * A non-zero exit is a runner's verdict about the code it ran. It is not the
 * runner's verdict about the command it was handed. When an invocation names a
 * test, a file, a module, an environment, or a program that does not exist, the
 * runner never reaches any code and still exits non-zero — and at the tool
 * boundary that is indistinguishable from the bug reproducing. A SWE-bench run
 * lost thirty-nine frames to exactly that: the reproduction named a test method
 * the class does not define, so it read `exitCode: 1` before the edit and
 * `exitCode: 1` after it, and the agent could not tell it had already won.
 *
 * This module names that class. The taxonomy is one idea — *the invocation
 * named something that does not exist* — and {@link Reason} enumerates the five
 * things that something can be. The recognisers are evidence for the class, not
 * a catalogue of runners: two of them are the POSIX exit codes every shell
 * reports, and the rest are the phrases runners print when name resolution
 * fails before execution begins. Nothing here knows a repository, a path, or a
 * benchmark instance, and nothing that does may be added.
 *
 * A flow that can tell the difference reports it under the reserved output key
 * {@link key}. The harness reads that key off an otherwise opaque call result
 * and refuses to count such a result as evidence that anything about the tree
 * changed, which is what stops a broken probe from being cited as a
 * reproduction.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"

/**
 * The reserved output key a flow reports an invalid probe under.
 *
 * Stated as a constant because it is a wire contract with the harness rather
 * than a shared type: `@smthrs/harness` reads this key off a `Schema.Json`
 * result and must not depend on the tool library to do it.
 *
 * @category identifiers
 * @since 0.1.0
 */
export const key = "invalidProbe"

/**
 * What the invocation named that does not exist.
 *
 * Five members, and adding a recogniser means adding evidence for one of them
 * rather than adding a member.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Reason = Schema.Literals([
  "unknown-command",
  "unknown-test",
  "unknown-path",
  "unknown-module",
  "unknown-environment"
])

/**
 * What the invocation named that does not exist.
 *
 * @category models
 * @since 0.1.0
 */
export type Reason = typeof Reason.Type

/**
 * One command's failure, attributed to the command rather than to the tree.
 *
 * @category schemas
 * @since 0.1.0
 */
export const InvalidProbe = Schema.Struct({
  reason: Reason.annotate({ description: "Which kind of name the command could not resolve" }),
  evidence: Schema.String.annotate({ description: "The output line this classification was read from" }),
  message: Schema.String.annotate({ description: "What the failure does and does not prove, stated for the caller" })
})

/**
 * One command's failure, attributed to the command rather than to the tree.
 *
 * @category models
 * @since 0.1.0
 */
export type InvalidProbe = typeof InvalidProbe.Type

/** What each reason means, in the second half of one sentence. */
const named: Record<Reason, string> = {
  "unknown-command": "the shell could not find the program it was asked to run",
  "unknown-test": "the test runner could not find the test that was named",
  "unknown-path": "the file or directory that was named does not exist",
  "unknown-module": "the module that was imported does not exist here",
  "unknown-environment": "the runner has no environment by that name"
}

const explain = (reason: Reason): string =>
  `This command never ran a check: ${
    named[reason]
  }. The non-zero exit describes the command, not the code under test, so it is not a reproduction and reads the same before and after a correct fix. Find the real names, repair the command, and run it again before drawing any conclusion from it.`

/** How much of the matched line is kept as evidence. */
const evidenceWidth = 240

interface Recogniser {
  readonly reason: Reason
  readonly pattern: RegExp
}

/**
 * Phrases that mean a runner refused a name before it ran anything.
 *
 * Ordered most specific first, and every pattern is anchored on wording the
 * runner itself emits at load time. Precision is the design constraint: a
 * recogniser that fires on a genuine reproduction would suppress real evidence,
 * which is worse than missing an invalid probe.
 */
const recognisers: ReadonlyArray<Recogniser> = [
  // unittest could not import or load the target it was given, so it
  // synthesises a placeholder case whose whole purpose is to report that.
  { reason: "unknown-test", pattern: /unittest\.loader\._FailedTest/ },
  // The class loaded and the method is not on it. This is the django case:
  // `type object 'AdminViewBasicTest' has no attribute 'test_catch_all_…'`.
  { reason: "unknown-test", pattern: /has no attribute '(?:test[A-Za-z0-9_]*)'/ },
  // pytest resolved the file and could not resolve the node id inside it.
  { reason: "unknown-test", pattern: /^ERROR: not found:/m },
  { reason: "unknown-path", pattern: /^ERROR: file or directory not found:/m },
  // `python missing.py`, and every wrapper that shells out the same way.
  { reason: "unknown-path", pattern: /can't open file '[^']*': \[Errno 2\]/ },
  { reason: "unknown-module", pattern: /(?:ModuleNotFoundError|ImportError): No module named/ },
  // tox and nox both phrase a missing environment this way.
  { reason: "unknown-environment", pattern: /unknown environment/i },
  // bash and zsh.
  { reason: "unknown-command", pattern: /: command not found/ },
  // dash, which prints `sh: 1: pytest: not found`.
  { reason: "unknown-command", pattern: /^[^\n:]+: \d+: [^\n:]+: not found$/m }
]

/** The whole line one pattern matched, trimmed and clipped. */
const matchedLine = (text: string, pattern: RegExp): string | undefined => {
  const match = pattern.exec(text)
  if (match === null) return undefined
  const start = text.lastIndexOf("\n", match.index) + 1
  const end = text.indexOf("\n", match.index)
  const line = (end === -1 ? text.slice(start) : text.slice(start, end)).trim()
  return line.length > evidenceWidth ? `${line.slice(0, evidenceWidth - 1)}…` : line
}

const invalid = (reason: Reason, evidence: string): InvalidProbe => ({
  reason,
  evidence,
  message: explain(reason)
})

/**
 * Classifies one command result as an invalid probe, or as an ordinary result.
 *
 * A zero exit is never classified: a command that ran is a command that ran,
 * whatever it printed. Everything else is read for the two independent kinds of
 * evidence — the runner's own load-time wording, then the shell's reserved exit
 * codes — and the first that fires wins.
 *
 * Pass the text the caller will actually return, so the evidence line is always
 * quotable from the output the reader can see.
 *
 * @category classification
 * @since 0.1.0
 */
export const classify = (result: {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}): InvalidProbe | undefined => {
  if (result.exitCode === 0) return undefined
  const text = result.stderr === ""
    ? result.stdout
    : result.stdout === ""
    ? result.stderr
    : `${result.stdout}\n${result.stderr}`
  for (const recogniser of recognisers) {
    const line = matchedLine(text, recogniser.pattern)
    if (line !== undefined) return invalid(recogniser.reason, line)
  }
  // POSIX reserves these two for the shell's own refusal to start the command
  // at all: 127 is "not found", 126 is "found and not executable". No runner
  // reaches its own tests and then reports either one.
  return result.exitCode === 127 || result.exitCode === 126
    ? invalid("unknown-command", `the command exited ${result.exitCode}`)
    : undefined
}
