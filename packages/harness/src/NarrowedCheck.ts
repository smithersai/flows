/**
 * The narrowing ledger: which checks this run has run, and over which tree.
 *
 * A run finishes by claiming its work is done. The evidence for that claim is
 * the checks it actually ran, and a check is only evidence for the tree it ran
 * over. The failure this module names is a completion whose last check is a
 * *narrowed* version of one the run had already run in full, taken after the
 * workspace moved and never followed by the broad one: the narrow result is
 * true, the broad one is unknown, and the run reports the unknown half as
 * proven.
 *
 * It is not hypothetical, and it is not one instance's accident. On a graded
 * benchmark the same run shape decided the same instance twice, in two
 * consecutive waves, identically. The journal of the second reads: the run ran
 * `pytest -rA testing/test_collection.py` in full, used its three failures to
 * discard a wrong candidate, edited two source files, re-ran the *same command
 * with a `-k` filter selecting four of seventy-two names* — "4 passed, 68
 * deselected" — and completed on that frame. The graded patch passed both
 * target tests and 144 of 145 neighbours; the one it broke was among the 68 the
 * filter dropped, and the run had watched that exact test pass, on the exact
 * command, before the change that broke it.
 *
 * The harness does not re-run anything to find this out. It compares two things
 * it already records — the input of every call, and the workspace digest each
 * frame closed on — and hands the run one sentence naming the check it is
 * missing. What the run does with that is the run's business: re-run the broad
 * check, or say why it no longer applies. The loop asks once and accepts what
 * comes back, because a harness that verified completions itself would be
 * grading the agent's work with its own, and that hack was removed on purpose.
 *
 * @since 0.1.0
 */
import * as CanonicalJson from "@smthrs/model/CanonicalJson"
import { Effect, Schema } from "effect"

/**
 * How many distinct checks one run carries forward.
 *
 * The ledger is controller state, so it is bounded. Thirty-two covers a whole
 * run at the rate a graded wave actually calls flows — its longest run issued
 * 43 calls across 24 frames, most of them reads of one file — so the broad
 * check a run ran early is still recognisable when it completes. A run that
 * outlives the bound forgets its oldest checks first, which can cost a demand
 * and can never invent one.
 *
 * @category constants
 * @since 0.1.0
 */
export const retained = 32

/**
 * Most distinct terms one recorded check may carry.
 *
 * A ledger entry stores the terms of a call's input, so an input that is mostly
 * *content* — a patch, a file body, a generated document — would store that
 * content twice over. Such a call is also not a check anybody narrows: nothing
 * re-runs a file write with an added filter. The largest input any flow issued
 * across five graded runs carried 119 terms, so the bound is more than twice
 * the observed ceiling and drops only inputs that are payloads.
 *
 * @category constants
 * @since 0.1.0
 */
export const maxTerms = 256

/**
 * Characters that are part of a term; everything else separates two.
 *
 * The set keeps together every shape that names one thing — `src/_pytest/main.py`,
 * `-rA`, `--include=*.py` minus its glob, a version, a container name — and cuts
 * at whitespace, quotes, brackets, colons, and JSON punctuation. It is the only
 * lexical assumption in this module, and it is about text rather than about any
 * tool: nothing here knows what a test runner, a flag, or a path is.
 *
 * A colon separates because it is what joins a target to a selector inside it —
 * a test id, a line number, a range. Cutting there leaves the file as a target
 * and the selector as an added condition, which is what selecting one case out
 * of a file is; keeping them together would make the pair a target of its own
 * and the narrowing invisible.
 */
const separator = /[^A-Za-z0-9_./@+-]+/

/**
 * How much of a check's input the demand may quote back.
 *
 * The demand has to name the check the run is missing, and a name it cannot
 * read is not a name. Bounded because the label lives in controller state,
 * once per retained entry.
 */
const labelWidth = 320

const clip = (text: string, width: number): string => text.length > width ? `${text.slice(0, width - 1)}…` : text

/**
 * Whether a term names a target rather than a condition.
 *
 * The distinction is what keeps {@link narrows} one-directional. A call that
 * repeats every term of an earlier call and adds a *condition* — a filter, a
 * selector, a flag — asks for a subset of what the earlier call covered. A call
 * that adds a *target* asks about something the earlier call never looked at,
 * which is a broader question, not a narrower one; running two files where one
 * ran before is not a narrowing and must not be demanded as one.
 *
 * A term is read as a target when it carries a separator inside it — a slash or
 * a dot. That covers paths, file names, dotted module names, and node ids, and
 * it reads a version number or a decimal as a target too. Both errors are in
 * the same direction: a term wrongly read as a target suppresses a demand, and
 * a demand this module does not issue costs nothing.
 *
 * Exported because `UnresolvedFailure` asks a different question of the same
 * distinction — whether a later call came back to what an earlier one was about
 * — and a second copy of this predicate would be a second thing to keep true.
 *
 * @category predicates
 * @since 0.1.0
 */
export const targeting = (term: string): boolean => term.includes("/") || term.includes(".")

/**
 * The distinct terms of one call input, sorted.
 *
 * The whole canonical input is lexed, keys included, so the relation works for
 * a shell command, a structured search, and any host flow this harness has
 * never heard of. Sorted and de-duplicated because the only questions asked of
 * it are set questions.
 *
 * @category conversions
 * @since 0.1.0
 */
export const terms = (input: Schema.Json): ReadonlyArray<string> =>
  [...new Set(CanonicalJson.stringify(input).split(separator).filter((term) => term.length > 0))].sort()

/**
 * One check this run has run, and the tree it ran over.
 *
 * A call becomes a check when it settled successfully and declared no write.
 * "Successfully" is about the call and not about the result: a command that
 * exits non-zero settled successfully, and its output — clean or informative —
 * is exactly what a run reads before deciding what to change. The graded run
 * this module was built from used the three failures its broad check reported
 * to discard a wrong candidate; a rule that only remembered green checks would
 * have forgotten the most useful thing that run ever ran. A call the flow could
 * not run at all observed nothing, and a call that changes the workspace is not
 * an observation of it.
 *
 * @category models
 * @since 0.1.0
 */
export class Check extends Schema.Class<Check>("flows/harness/NarrowedCheck/Check")({
  /** The flow the call named. */
  flow: Schema.String,
  /** The call's identity, as the controller's own signature names it. */
  signature: Schema.String,
  /** The distinct terms of the call's input, sorted; see {@link terms}. */
  terms: Schema.Array(Schema.String),
  /**
   * Content address of the workspace the frame that ran this check closed on.
   *
   * The *closing* digest, and not the opening one, because a frame's calls are
   * not ordered against its edits in anything the harness records. A check that
   * ran in the same frame as an edit is therefore stamped as if it ran after
   * that edit, which reads a stale check as current and suppresses a demand.
   * Conservative on purpose: the whole module errs towards asking nothing.
   *
   * Empty when the frame had no complete measurement to stamp it with, which
   * makes the entry inert — an unmeasured tree cannot say anything moved.
   */
  digest: Schema.String,
  /** The call's input as it was written, clipped, for the demand to quote. */
  label: Schema.String,
  /**
   * Whether the call's own result reported a failing exit status.
   *
   * Nothing in this module reads it: a check that reported failures is exactly
   * as good evidence of what the tree does as one that reported none, and the
   * narrowing relation is about the shape of a question rather than its answer.
   * It is recorded here because `UnresolvedFailure` asks about the answer, and
   * two ledgers over the same calls would be two things to keep true. See
   * `UnresolvedFailure` `failed` for what "reported" means, and why a flow that
   * declares no exit status is neither failing nor passing.
   */
  failing: Schema.Boolean.pipe(
    Schema.withConstructorDefault(Effect.succeed(false)),
    Schema.withDecodingDefaultKey(Effect.succeed(false))
  ),
  /**
   * Whether the frame that ran this check left the workspace as it found it.
   *
   * A frame's calls are not ordered against its edits in anything the harness
   * records, so a check taken in a frame that also edited is stamped with that
   * frame's closing digest whether it ran before or after the edit. For
   * {@link find} that reads a stale check as current and costs a demand. For a
   * *failure* carried by such a check the same stamp would attribute a result
   * to a tree the check never ran over, so `UnresolvedFailure` requires this.
   */
  stable: Schema.Boolean.pipe(
    Schema.withConstructorDefault(Effect.succeed(false)),
    Schema.withDecodingDefaultKey(Effect.succeed(false))
  )
}) {}

/**
 * A check this frame ran, paired with the broader one it stands in for.
 *
 * @category models
 * @since 0.1.0
 */
export interface Narrowing {
  /** The broader check, last run over a tree that has since changed. */
  readonly earlier: Check
  /** This frame's check, which repeats it and adds conditions. */
  readonly later: Check
}

/**
 * Records one settled call as a check, unless its input is a payload.
 *
 * `undefined` is not a failure: it is an input with more distinct terms than
 * {@link maxTerms}, which is a call carrying content rather than a question.
 *
 * @category constructors
 * @since 0.1.0
 */
export const check = (options: {
  readonly flow: string
  readonly signature: string
  readonly input: Schema.Json
  readonly digest: string
  /** Whether the call's result reported a failing exit status. */
  readonly failing?: boolean | undefined
  /** Whether the frame that ran it left the workspace as it found it. */
  readonly stable?: boolean | undefined
}): Check | undefined => {
  const collected = terms(options.input)
  if (collected.length > maxTerms) return undefined
  return new Check({
    flow: options.flow,
    signature: options.signature,
    terms: collected,
    digest: options.digest,
    label: clip(CanonicalJson.stringify(options.input), labelWidth),
    failing: options.failing ?? false,
    stable: options.stable ?? false
  })
}

/**
 * Whether one call's terms are a strict narrowing of another's.
 *
 * The relation is: every term the earlier call carried is carried again, at
 * least one term is added, and no added term names a target
 * ({@link targeting}). In words — same question, more conditions on it. It is
 * deliberately syntactic. It parses no flag, knows no test runner, and would
 * hold identically for a search flow, a linter, or a host flow written after
 * this one; the moment it started reading `-k` it would be a rule about pytest
 * rather than a rule about evidence.
 *
 * @category predicates
 * @since 0.1.0
 */
export const narrows = (
  later: ReadonlyArray<string>,
  earlier: ReadonlyArray<string>
): boolean => {
  const carried = new Set(later)
  for (const term of earlier) if (!carried.has(term)) return false
  const known = new Set(earlier)
  let added = false
  for (const term of later) {
    if (known.has(term)) continue
    if (targeting(term)) return false
    added = true
  }
  return added
}

/**
 * Finds the broadest check a completing frame narrowed and did not re-run.
 *
 * All four conditions have to hold, and each of them is read off something the
 * harness already records rather than off anything a cell said about itself:
 *
 * 1. the frame closed on a complete measurement, so a digest means something;
 * 2. some earlier check was last run over a *different* tree, which is what
 *    "you have changed something since" means with no timestamps involved;
 * 3. this frame issued no call with that check's exact signature, so the run
 *    did not simply re-run it here;
 * 4. some call this frame issued names the same flow and {@link narrows} it.
 *
 * The broadest such earlier check wins — fewest terms, which under this
 * module's own relation is the least constrained question — so the demand names
 * the strongest evidence the completion is missing rather than the first one
 * found. Ties go to the more recently run check.
 *
 * @category conversions
 * @since 0.1.0
 */
export const find = (options: {
  /** Checks this run ran before this frame, oldest first. */
  readonly ledger: ReadonlyArray<Check>
  /** Checks this frame ran. */
  readonly frame: ReadonlyArray<Check>
  /** The workspace digest this frame closed on; empty when unmeasured. */
  readonly digest: string
}): Narrowing | undefined => {
  if (options.digest === "") return undefined
  const reran = new Set(options.frame.map((entry) => entry.signature))
  let found: Narrowing | undefined = undefined
  for (const earlier of options.ledger) {
    if (reran.has(earlier.signature)) continue
    if (earlier.digest === "") continue
    if (earlier.digest === options.digest) continue
    if (found !== undefined && found.earlier.terms.length < earlier.terms.length) continue
    for (const later of options.frame) {
      if (later.flow !== earlier.flow) continue
      if (!narrows(later.terms, earlier.terms)) continue
      found = { earlier, later }
      break
    }
  }
  return found
}

/**
 * States which check a completion is standing on, and which one it is missing.
 *
 * The text asks for a decision and names both ways out as equals, in the shape
 * the read-only demand already uses: re-run the check that was skipped, or say
 * why it does not apply. It never asserts the run is wrong — a filter can be
 * the right check after a change that removed cases — it asserts only what is
 * true from the record: the broad result the run is relying on was measured on
 * a tree that no longer exists.
 *
 * It also says plainly that nothing re-runs the check for the run, and that the
 * next answer stands. Anything softer invites a re-submission of the same
 * frame; anything harder would be the harness pretending it will keep score.
 *
 * @category constructors
 * @since 0.1.0
 */
export const demand = (found: Narrowing): string =>
  `Narrowed verification — your last verification is narrower than a check this run has already run in full, and the workspace has changed since that broader check last ran.

- the broader check, last run before your latest change: ${found.earlier.flow} ${found.earlier.label}
- the check this frame ran instead: ${found.later.flow} ${found.later.label}

The second repeats every term of the first and adds conditions to it, so it reports on a part of what the first covered and says nothing about the rest — and the rest is exactly where a change breaks something that was passing. Re-run ${found.earlier.flow} with that earlier input, byte for byte, and complete once you have seen what it prints; or complete and state in your output why that check no longer applies to the change you made. Nothing re-runs it for you, and what you return next is the answer that stands.`

/**
 * Folds this frame's checks into the run's ledger, newest last and bounded.
 *
 * A repeated signature moves to the newest position rather than taking a second
 * slot, so a run looping on one command cannot push the broad check it ran
 * early out of the ledger — and its digest is restamped, which is how re-running
 * a check answers the demand it caused.
 *
 * @category conversions
 * @since 0.1.0
 */
export const remember = (
  ledger: ReadonlyArray<Check>,
  added: ReadonlyArray<Check>
): ReadonlyArray<Check> => {
  const newest = new Map(ledger.map((entry) => [entry.signature, entry]))
  for (const entry of added) {
    newest.delete(entry.signature)
    newest.set(entry.signature, entry)
  }
  const distinct = [...newest.values()]
  return distinct.slice(Math.max(0, distinct.length - retained))
}

/**
 * The ledger schema carried in controller state.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Ledger = Schema.Array(Check).pipe(
  Schema.withConstructorDefault(Effect.succeed<ReadonlyArray<Check>>([])),
  Schema.withDecodingDefaultKey(Effect.succeed<ReadonlyArray<Check>>([]))
)
