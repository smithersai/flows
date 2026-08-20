/**
 * Blocker classification.
 *
 * When a reproduction attempt fails, the first question is whether it failed
 * for the reason the report describes or for a reason that has nothing to do
 * with it. Getting that wrong is the expensive mistake: a reporter told "we
 * could not reproduce this" when the truth was "our registry was down" learns
 * not to file issues.
 *
 * The classifier is textual and deliberately conservative. Anything it cannot
 * place is `unrelated: false`, which means the run treats the failure as
 * evidence about the report. A false "blocked" parks a real bug; a false
 * "not blocked" only costs a re-run.
 */

/** What kind of thing went wrong. */
export type BlockerKind =
  | "install"
  | "baseline"
  | "toolchain"
  | "quota"
  | "network"
  | "unclassified"

/** One classification verdict. */
export interface Blocker {
  readonly kind: BlockerKind
  /** Whether the failure is unrelated to the report under test. */
  readonly unrelated: boolean
  /** The operator-facing sentence, used in the blocker issue's title. */
  readonly summary: string
}

interface Rule {
  readonly kind: BlockerKind
  readonly summary: string
  readonly patterns: ReadonlyArray<RegExp>
}

/**
 * The rules, most specific first.
 *
 * Each pattern is anchored on text a tool actually prints, not on a word that
 * happens to appear in it. `ERR_PNPM_OUTDATED_LOCKFILE` is an install failure;
 * the word "install" in a stack trace is not.
 */
export const rules: ReadonlyArray<Rule> = [
  {
    kind: "quota",
    summary: "a provider quota or rate limit was exhausted",
    patterns: [
      /\b429\b[^\n]*too many requests/i,
      /rate limit (?:exceeded|reached)/i,
      /\bquota (?:exceeded|exhausted)\b/i,
      /insufficient_quota/i,
      /\bAPI limit exceeded\b/i
    ]
  },
  {
    kind: "install",
    summary: "the dependency install failed",
    patterns: [
      /ERR_PNPM_[A-Z_]+/,
      /npm ERR! code E[A-Z]+/,
      /Cannot install with "frozen-lockfile"/i,
      /lockfile .* is not up to date/i,
      /\bEINTEGRITY\b/
    ]
  },
  {
    kind: "network",
    summary: "the runner could not reach a required host",
    patterns: [
      /\b(?:ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN)\b/,
      /getaddrinfo\b/,
      /TLS handshake timeout/i
    ]
  },
  {
    kind: "toolchain",
    summary: "a required tool or platform was missing from the runner",
    patterns: [
      /command not found/i,
      /\bENOENT\b[^\n]*spawn/i,
      /is not recognized as an internal or external command/i,
      /unsupported platform/i,
      /requires (?:node|Node\.js) >=/i
    ]
  },
  {
    kind: "baseline",
    summary: "the baseline on main is already red, independent of this report",
    patterns: [
      /baseline (?:is |run )?(?:already )?(?:red|failing)/i,
      /pre-existing failure on main/i,
      /unrelated test failures? on main/i
    ]
  }
]

/** The verdict for a failure nothing matched. */
export const unclassified: Blocker = {
  kind: "unclassified",
  unrelated: false,
  summary: "the failure was not recognised as an infrastructure blocker"
}

/**
 * Classifies one failure log.
 *
 * Only the tail is read. A reproduction log is mostly successful setup, and
 * the words that decide the verdict are at the end; reading the whole thing
 * lets an early, recovered-from warning outvote the actual failure.
 */
export const classify = (log: string, tailBytes = 32 * 1024): Blocker => {
  const tail = log.length <= tailBytes ? log : log.slice(log.length - tailBytes)
  for (const rule of rules) {
    if (rule.patterns.some((pattern) => pattern.test(tail))) {
      return { kind: rule.kind, unrelated: true, summary: rule.summary }
    }
  }
  return unclassified
}

/** The title an `infra`-labelled blocker issue gets. */
export const blockerTitle = (blocker: Blocker): string => `infra: ${blocker.summary}`

/**
 * The body of a blocker issue.
 *
 * It carries the classification and the log tail and nothing else. A blocker
 * issue is a pointer, not a report: the reports it blocks link to it, and it
 * closing is what unparks them.
 */
export const blockerBody = (blocker: Blocker, log: string, blockedIssues: ReadonlyArray<number>): string =>
  [
    `Reproduction runs are failing for a reason unrelated to the reports under test: ${blocker.summary}.`,
    "",
    `Classification: \`${blocker.kind}\`.`,
    "",
    blockedIssues.length === 0
      ? "No reports are parked on this yet."
      : `Parked reports: ${blockedIssues.map((number) => `#${String(number)}`).join(", ")}.`,
    "",
    "Closing this issue unparks them on the next scheduled sweep.",
    "",
    "<details><summary>Log tail</summary>",
    "",
    "```",
    log.slice(Math.max(0, log.length - 8 * 1024)),
    "```",
    "",
    "</details>"
  ].join("\n")
