/**
 * Turning a verified report into a `factory/queue/` item.
 *
 * The queue is already the factory's intake, so a verified bug does not get a
 * second one. This module renders exactly the format `factory/queue/README.md`
 * documents, with the routing frontmatter derived from the issue's labels
 * rather than chosen by an agent: priority and anchor are policy, and policy
 * belongs in a function a person can read.
 */

/** The queue directory. */
export const queueDirectory = "factory/queue"

/** One queue item's routing frontmatter. */
export interface Routing {
  readonly status: "queued"
  readonly anchor: "narrative" | "head"
  readonly priority: "p0" | "p1" | "p2"
}

/**
 * Derives routing from an issue's labels.
 *
 * A verified repro anchors on `head` because the fix must sit on the tip that
 * the proof gate measured against; folding it into the retold narrative is a
 * separate, later decision. Priority follows an explicit `p0`/`p1`/`p2` label,
 * then a severity label, then the default.
 */
export const routing = (labels: ReadonlyArray<string>): Routing => {
  const priority = labels.includes("p0") || labels.includes("severity:critical")
    ? "p0"
    : labels.includes("p2") || labels.includes("severity:low")
    ? "p2"
    : "p1"
  return { status: "queued", anchor: "head", priority }
}

/** The slug one issue's queue item is filed under. */
export const slug = (issue: number, title: string): string => {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter((word) => word !== "")
    .slice(0, 6)
    .join("-")
  return `issue-${String(issue)}${words === "" ? "" : `-${words}`}`
}

/** The path one issue's queue item is written to. */
export const itemPath = (issue: number, title: string): string => `${queueDirectory}/${slug(issue, title)}.md`

/**
 * Renders one queue item.
 *
 * The prompt states the two things the implementing lane must not get wrong:
 * the repro is the acceptance test, and it lands as a permanent regression
 * test rather than being deleted once it goes green.
 */
export const render = (options: {
  readonly issue: number
  readonly title: string
  readonly labels: ReadonlyArray<string>
  readonly reproProgram: string
  readonly claim: string
}): string => {
  const route = routing(options.labels)
  return [
    "---",
    `status: ${route.status}`,
    `anchor: ${route.anchor}`,
    `priority: ${route.priority}`,
    `issue: ${String(options.issue)}`,
    "---",
    "",
    `Fix the defect reported in #${String(options.issue)}: ${options.title}`,
    "",
    options.claim.trim(),
    "",
    `The reproduction is \`${options.reproProgram}\`. It fails on \`main\` today and the reporter has`,
    "confirmed it captures their issue, so it is the acceptance test for this change.",
    "",
    "Two constraints on the landing:",
    "",
    `1. The repro moves into the affected package's test suite. It stays a permanent regression`,
    "   test; do not delete it once it passes.",
    `2. The pull request body carries \`Closes #${String(options.issue)}\`, and the diff touches`,
    `   \`factory/repros/${String(options.issue)}/\`, because the proof gate reads both.`,
    ""
  ].join("\n")
}
