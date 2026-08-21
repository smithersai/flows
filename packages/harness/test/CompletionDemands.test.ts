/**
 * The three completion demands, replayed over the wave they were designed
 * against.
 *
 * The fixture is the five journals of SWE-bench wave 9, distilled by
 * `evals/swebench/lib/narrowing-journals.mjs` to exactly what the detectors
 * read: every settled call's flow, input and outcome, what its result said
 * about its subject's exit status and about whether it ran a check at all, the
 * digest each frame closed on and whether that frame moved the tree, and the
 * digest the run opened on. Nothing here is a reconstruction: every field is
 * copied out of a `control.agent.*` event or a `workspace-open` boundary.
 *
 * Three of those runs resolved their instance. The demands must be silent on
 * all three, and this file is where that is enforced: a change to any detector
 * that starts asking something of `astropy__astropy-8707`,
 * `pydata__xarray-7393` or `sphinx-doc__sphinx-11445` has to explain itself
 * against real journals rather than against a memory of what a wave once did.
 * `astropy__astropy-8707` is the sharpest of the three — it ran a broad check
 * after its edit, was told "2 failed, 148 passed", and completed anyway, which
 * is why `UnresolvedFailure` is not a rule about failing checks.
 *
 * The two that did not resolve are the two the demands were written for.
 * `django__django-16612` completed after seven frames that made no editing call
 * of any kind, on the digest it opened on, with a sentence describing an edit;
 * its captured patch was zero bytes. `pytest-dev__pytest-6197` ran
 * `pytest -rA testing/python/collect.py` after its final edit, was told "2
 * failed, 72 passed", ran four named cases out of that same file, was told "4
 * passed", and completed on the second reading.
 *
 * The replay drives the detectors directly rather than the loop, for the same
 * reason `NarrowedCheck.test.ts` does: the loop needs a model, a sandbox and an
 * engine, and none of those decide anything here.
 */
import type { Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as NarrowedCheck from "../src/NarrowedCheck.ts"
import * as UnmovedTree from "../src/UnmovedTree.ts"
import * as UnresolvedFailure from "../src/UnresolvedFailure.ts"
import journals from "./fixtures/completionJournals.json" with { type: "json" }

type Journal = typeof journals.journals[number]

/** One demand the completing frame of a replayed run produced. */
interface Fired {
  readonly demand: string
  /** Seq of the `transition-applied` event the demand was issued at. */
  readonly seq: number
  /** Seqs of the calls the demand names, where it names any. */
  readonly names: ReadonlyArray<number>
}

/**
 * Replays one run's frames through the completion branch's own ordering.
 *
 * The ledger, the digests and the precedence are the controller's; what is left
 * out is everything that cannot change a demand — the model, the sandbox, the
 * frame budget, and the caps, which are replayed armed at one because that is
 * the shipped default and the question here is what the detectors see.
 */
const replay = (journal: Journal): ReadonlyArray<Fired> => {
  let ledger: ReadonlyArray<NarrowedCheck.Check> = []
  const seqOf = new Map<string, number>()
  const fired: Array<Fired> = []
  for (const frame of journal.frames) {
    // A partial or absent walk records no digest, exactly as the loop does.
    const digest = frame.basis === "observed" ? frame.digest : ""
    const checks = frame.calls.flatMap((call) => {
      if (!call.ok || call.mutates) return []
      const signature = `${call.flow}:${JSON.stringify(call.input)}`
      const recorded = NarrowedCheck.check({
        flow: call.flow,
        signature,
        input: call.input as Schema.Json,
        digest,
        failing: UnresolvedFailure.failed(("exit" in call ? { exitCode: call.exit } : {}) as Schema.Json)
          && !("probe" in call),
        stable: !frame.mutated
      })
      if (recorded === undefined) return []
      seqOf.set(signature, call.seq)
      return [recorded]
    })
    const whole = NarrowedCheck.remember(ledger, checks)
    if (frame.transition === "complete" && fired.length === 0) {
      const seq = frame.transitionSeq ?? 0
      const unmoved = UnmovedTree.find({ opened: journal.openedOn, digest })
      const unresolved = unmoved === undefined
        ? UnresolvedFailure.find({ ledger: whole, digest })
        : undefined
      const narrowing = unmoved === undefined && unresolved === undefined
        ? NarrowedCheck.find({ ledger, frame: checks, digest })
        : undefined
      if (unmoved !== undefined) fired.push({ demand: "unmoved-tree", seq, names: [] })
      else if (unresolved !== undefined) {
        fired.push({
          demand: "unresolved-failure",
          seq,
          names: [seqOf.get(unresolved.failed.signature) ?? 0, seqOf.get(unresolved.instead.signature) ?? 0]
        })
      } else if (narrowing !== undefined) {
        fired.push({
          demand: "narrowed-check",
          seq,
          names: [seqOf.get(narrowing.earlier.signature) ?? 0, seqOf.get(narrowing.later.signature) ?? 0]
        })
      }
    }
    ledger = whole
  }
  return fired
}

const journalOf = (instance: string): Journal => {
  const found = journals.journals.find((entry) => entry.instance === instance)
  if (found === undefined) throw new Error(`the wave-9 fixture is missing ${instance}`)
  return found
}

describe("the completion demands over the recorded wave", () => {
  it.each(
    journals.journals.filter((journal) =>
      journal.instance !== "django__django-16612" && journal.instance !== "pytest-dev__pytest-6197"
    )
  )("demands nothing of $instance, which resolved", (journal) => {
    expect(replay(journal)).toEqual([])
  })

  it("demands the missing change exactly once of django__django-16612", () => {
    const journal = journalOf("django__django-16612")

    // Seven frames, eleven calls — three `read`, seven `grep`, one `bash` —
    // and not one editing call. Every frame closed on the digest the run
    // opened on, and the run completed with "Updated
    // `AdminSite.catch_all_view()` to preserve query strings when
    // `APPEND_SLASH` redirects add a trailing slash."
    expect(journal.frames).toHaveLength(7)
    expect(journal.frames.every((frame) => !frame.mutated)).toBe(true)
    expect(replay(journal)).toEqual([{
      demand: "unmoved-tree",
      // `transition-applied` on the seventh frame.
      seq: 229,
      names: []
    }])
  })

  it("demands the unanswered failure exactly once of pytest-dev__pytest-6197", () => {
    const journal = journalOf("pytest-dev__pytest-6197")

    expect(journal.frames).toHaveLength(14)
    expect(replay(journal)).toEqual([{
      demand: "unresolved-failure",
      // `transition-applied` on the fourteenth frame, which made no call at
      // all — which is why `NarrowedCheck`, whose subject is the completing
      // frame's own checks, has nothing to say about this run.
      seq: 446,
      // Seq 394: `pytest -rA testing/python/collect.py`, exit 1, "2 failed, 72
      // passed", taken over the tree the run went on to complete on. Seq 429:
      // a `git diff` of two source files joined onto four named cases out of
      // that same file, exit 0, "4 passed". The first was never run again.
      names: [394, 429]
    }])
  })

  it("reads the failing check off the wave's own exit statuses and not off its output", () => {
    // The distinction the demand rests on, stated against the bytes: both
    // instances ran a broad check after their edit and both were told two
    // things failed. Nothing in the record separates those two results, and
    // nothing may — counting failures means parsing a runner's output, which
    // would make this a rule about pytest rather than a rule about evidence.
    const failing = (instance: string) =>
      journalOf(instance).frames.flatMap((frame) =>
        frame.calls.filter((call) => "exit" in call && call.exit !== 0 && !("probe" in call))
          .map((call) => call.seq)
      )

    expect(failing("pytest-dev__pytest-6197")).toEqual([58, 394])
    expect(failing("astropy__astropy-8707")).toEqual([57, 120, 191])
  })
})
