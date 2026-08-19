/**
 * The repro state machine, as labels.
 *
 * The issue's labels ARE the state. There is no side database, because every
 * participant — a maintainer, the reporter, an automation run, a person
 * reading the issue six months later — can see labels and nothing else. A run
 * that crashes halfway leaves the state where it was rather than in a store
 * nobody can inspect.
 *
 * This module is pure. It decides transitions; `github.ts` applies them.
 */

/** The maintainer gate label. Applying it admits an automation job. */
export const approvalLabel = "agent:approved"

/** The label a suspected duplicate carries pending maintainer confirmation. */
export const duplicateLabel = "dupe:candidate"

/** The label an infrastructure blocker issue carries. */
export const infrastructureLabel = "infra"

/** The PoC sub-states, in the order the loop walks them. */
export const pocLabels = ["poc:proposed", "poc:confirmed", "poc:rejected"] as const

/** The reproduction outcomes. */
export const reproLabels = ["repro:needs-info", "repro:verified", "repro:blocked"] as const

/** One PoC sub-state. */
export type PocLabel = typeof pocLabels[number]

/** One reproduction outcome. */
export type ReproLabel = typeof reproLabels[number]

/** Every label this state machine owns. Nothing else is touched. */
export const managedLabels: ReadonlyArray<string> = [
  ...pocLabels,
  ...reproLabels,
  duplicateLabel
]

/**
 * How many PoC attempts the loop makes before it stops guessing and asks.
 *
 * Three, because the failure mode a bound exists for is a model and a reporter
 * talking past each other, and that does not resolve on the fourth try. It
 * resolves when a person is asked a specific question.
 */
export const maximumPocAttempts = 3

/** What happened, as far as the state machine is concerned. */
export type Signal =
  | { readonly kind: "intake"; readonly strongDuplicate: boolean }
  | { readonly kind: "poc-proposed" }
  | { readonly kind: "reporter-confirmed" }
  | { readonly kind: "reporter-rejected"; readonly attempts: number }
  | { readonly kind: "poc-failed-on-main" }
  | { readonly kind: "poc-passed-on-main" }
  | { readonly kind: "blocked"; readonly blocker: string }
  | { readonly kind: "blocker-cleared" }
  | { readonly kind: "no-longer-reproduces" }

/** The label edit one signal implies. */
export interface Transition {
  /** Labels to add. */
  readonly add: ReadonlyArray<string>
  /** Labels to remove. */
  readonly remove: ReadonlyArray<string>
  /** Whether the automation stops here and waits for a person. */
  readonly halt: boolean
  /** Why, in one sentence, for the comment the applier posts. */
  readonly reason: string
}

const only = (keep: ReadonlyArray<string>, current: ReadonlyArray<string>): ReadonlyArray<string> =>
  managedLabels.filter((label) => !keep.includes(label) && current.includes(label))

/**
 * Decides the label edit one signal implies, given the labels the issue
 * carries now.
 *
 * Removals are computed against the current labels rather than stated blindly,
 * so a transition never asks GitHub to remove a label that is not there. That
 * matters because `gh issue edit --remove-label` fails on a missing label, and
 * a failed bookkeeping call is an automation run that stops halfway.
 */
export const transition = (signal: Signal, current: ReadonlyArray<string>): Transition => {
  switch (signal.kind) {
    case "intake":
      return signal.strongDuplicate
        ? {
          add: [duplicateLabel],
          remove: only([duplicateLabel], current),
          halt: true,
          reason: "A strong duplicate candidate was found. A maintainer confirms or removes the label."
        }
        : { add: [], remove: [], halt: false, reason: "Intake found no strong duplicate." }
    case "poc-proposed":
      return {
        add: ["poc:proposed"],
        remove: only(["poc:proposed"], current),
        halt: true,
        reason: "A proof of concept was posted. The reporter is asked whether it captures the issue."
      }
    case "reporter-confirmed":
      return {
        add: ["poc:confirmed"],
        remove: only(["poc:confirmed"], current),
        halt: false,
        reason: "The reporter confirmed the proof of concept."
      }
    case "reporter-rejected":
      return signal.attempts >= maximumPocAttempts
        ? {
          add: ["poc:rejected", "repro:needs-info"],
          remove: only(["poc:rejected", "repro:needs-info"], current),
          halt: true,
          reason:
            `The proof of concept was rejected ${String(signal.attempts)} times. Targeted questions were posted instead.`
        }
        : {
          add: ["poc:rejected"],
          remove: only(["poc:rejected"], current),
          halt: false,
          reason: "The reporter rejected the proof of concept. A revised one follows."
        }
    case "poc-failed-on-main":
      // A repro is verified only when BOTH halves hold: the PoC fails on main
      // and the reporter said it is their issue. Failing on main alone proves
      // a bug exists, not that it is this one.
      return current.includes("poc:confirmed")
        ? {
          add: ["repro:verified"],
          remove: only(["repro:verified", "poc:confirmed"], current),
          halt: false,
          reason: "The proof of concept fails on main and the reporter confirmed it."
        }
        : {
          add: [],
          remove: [],
          halt: true,
          reason: "The proof of concept fails on main. Verification waits on the reporter's confirmation."
        }
    case "poc-passed-on-main":
      return {
        add: ["repro:needs-info"],
        remove: only(["repro:needs-info"], current),
        halt: true,
        reason: "The proof of concept passes on main, so it does not reproduce the report yet."
      }
    case "blocked":
      // A blocker never counts against the reporter: nothing here adds
      // repro:needs-info, and the PoC state is left exactly as it was so the
      // loop resumes where it stopped once the blocker closes.
      return {
        add: ["repro:blocked"],
        remove: only(["repro:blocked", ...pocLabels], current),
        halt: true,
        reason: `Reproduction is blocked by ${signal.blocker}, for reasons unrelated to this report.`
      }
    case "blocker-cleared":
      return {
        add: [],
        remove: current.includes("repro:blocked") ? ["repro:blocked"] : [],
        halt: false,
        reason: "The blocker closed. Reproduction is unparked."
      }
    case "no-longer-reproduces":
      return {
        add: [],
        remove: only([], current),
        halt: true,
        reason: "The repro no longer fails on main. The issue is closed with the evidence."
      }
  }
}

/**
 * Whether a comment body reads as the reporter confirming the proof.
 *
 * A deliberately narrow reading. The loop asks a yes/no question, so an
 * ambiguous reply is not a confirmation; it falls through to the agent, which
 * can ask again. Guessing here would mark a repro verified on the strength of
 * "thanks!".
 */
export const readsAsConfirmation = (body: string): boolean =>
  /^\s*(?:yes|yep|yeah|correct|confirmed|that'?s it|exactly)\b/i.test(body)

/** Whether a comment body reads as the reporter rejecting the proof. */
export const readsAsRejection = (body: string): boolean =>
  /^\s*(?:no|nope|not quite|that'?s not|incorrect|wrong)\b/i.test(body)

/** The PoC attempt count an issue's comment history implies. */
export const attemptsFrom = (bodies: ReadonlyArray<string>): number =>
  bodies.filter((body) => body.includes(pocMarker)).length

/**
 * The marker every PoC comment carries.
 *
 * Counting attempts by marker rather than by a stored counter keeps the state
 * where everything else lives: on the issue, visible, and correct after a run
 * that died mid-way.
 */
export const pocMarker = "<!-- factory:poc -->"
