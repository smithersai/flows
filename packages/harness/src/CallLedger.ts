/**
 * The call ledger: what this run has already asked, rendered every frame.
 *
 * A cell's results are durable, but they are invisible to the next model turn
 * unless the cell that made them happened to copy them into `context`. A cell
 * is authored blind — the model writes the whole program before it sees any of
 * its results — so copying is a guess made before the answer exists, and the
 * rational response is to split one logical step across two frames: one frame
 * to fetch, one to look. Thirty-one percent of the frames in one graded wave
 * made no flow call at all, and the justifications they volunteered name the
 * cause outright: "loaded the durable investigation results so the next frame
 * can edit without repeating repository reads".
 *
 * This ledger removes the guess. Every settled call of the run contributes one
 * line the harness derives on its own — ordinal, flow, what the call was about,
 * whether it settled ok, and a structural digest of what came back — so a model
 * can see what it has already asked without asking again. It carries no
 * payloads: a line says `stdout=4096b`, never the four kilobytes.
 *
 * It is a sibling of `NarrowedCheck` and `TruncatedOutput`: run-scoped
 * controller state, bounded, journal-derivable, and interpreting nothing about
 * any flow, tool, or repository.
 *
 * @since 0.1.0
 */
import * as CanonicalJson from "@smthrs/model/CanonicalJson"
import { Effect, Schema } from "effect"
import * as NarrowedCheck from "./NarrowedCheck.ts"

const NonNegativeSafeInt = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
)

/**
 * How many settled calls the rendered ledger carries, newest last.
 *
 * Thirty is above the whole call count of every round this harness has ever
 * completed at or near par — the five golfed instances settle 7 to 25 calls —
 * and it is a third of the call count of the worst recorded round, so a run
 * that has genuinely lost the thread is shown its recent history rather than
 * its whole one. Each line is bounded, so the section is bounded.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const bound = 30

/**
 * How much of one call's subject or result digest a line may quote.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const width = 120

/**
 * How many members of a result object the digest may name.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const members = 6

const clip = (text: string, limit: number): string => text.length > limit ? `${text.slice(0, limit - 1)}…` : text

/**
 * One settled call, as one line of the run's history.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export class Entry extends Schema.Class<Entry>("flows/harness/CallLedger/Entry")({
  /** The call's one-based position in the run's whole settled sequence. */
  ordinal: NonNegativeSafeInt,
  /** The flow the call named. */
  flow: Schema.String,
  /** What the call was about; see {@link subject}. */
  subject: Schema.String,
  /** Whether the call settled successfully. This is not the exit status. */
  ok: Schema.Boolean,
  /** The structural digest of what came back; see {@link digest}. */
  digest: Schema.String
}) {}

/**
 * The run's settled calls, oldest first and bounded to {@link bound}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const Ledger = Schema.Array(Entry).pipe(
  Schema.withConstructorDefault(Effect.succeed<ReadonlyArray<Entry>>([])),
  Schema.withDecodingDefaultKey(Effect.succeed<ReadonlyArray<Entry>>([]))
)

/**
 * The run's settled calls, oldest first and bounded to {@link bound}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Ledger = typeof Ledger.Type

/**
 * A term whose separator has a real character on both sides of it.
 *
 * `NarrowedCheck.targeting` reads any term carrying a slash or a dot as a
 * target, which is the right rule for the question that module asks — a term
 * wrongly read as a target only suppresses a demand there. This module needs
 * the stricter rule, because a subject a reader cannot recognize is worse than
 * no subject at all: a glob's leftover `/` and a bare `.py` both satisfy
 * `targeting` and name nothing, while `tests/test_a.py` and
 * `django.contrib.admin.sites` satisfy this.
 */
const anchored = /[A-Za-z0-9_@+-][./][A-Za-z0-9_@+-]/

/**
 * What one call was about: the first term of its input that names a target.
 *
 * `NarrowedCheck` already owns the lexer and the target/condition split, so a
 * path, a test id, a dotted module name, or the file inside a shell command is
 * picked out without this module knowing what any of those are. An input with
 * no such term is quoted whole instead, clipped — a grep that targets only a
 * glob is named by its own pattern and root, which is what makes the line
 * recognizable at all.
 *
 * @category conversions
 * @since 0.1.0
 * @slop
 */
export const subject = (input: Schema.Json): string => {
  const found = NarrowedCheck.lex(input).find((term) => NarrowedCheck.targeting(term) && anchored.test(term))
  return clip(found ?? CanonicalJson.stringify(input), width)
}

const scalar = (value: unknown): string => {
  if (typeof value === "string") return `${value.length}b`
  if (Array.isArray(value)) return `[${value.length}]`
  if (value !== null && typeof value === "object") return "{…}"
  return String(value)
}

/**
 * The one-line structural digest of what a call returned.
 *
 * Counts and statuses, never payloads: a member that is a string reports its
 * byte length, an array reports its length, a nested object reports that it is
 * one, and a number or boolean — an exit code, a truncation flag — reports
 * itself. Members are named in canonical key order and capped at
 * {@link members}, so the same result always renders the same line and a result
 * with fifty keys cannot take the frame over.
 *
 * @category conversions
 * @since 0.1.0
 * @slop
 */
export const digest = (value: Schema.Json): string => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return clip(scalar(value), width)
  const record = new Map(Object.entries(value))
  const keys = [...record.keys()].sort()
  const named = keys.slice(0, members).map((key) => `${key}=${scalar(record.get(key))}`)
  const rest = keys.length - named.length
  return clip([...named, ...(rest > 0 ? [`+${rest} more`] : [])].join(" "), width)
}

/**
 * One settled call, as the controller observed it.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Settlement {
  readonly flow: string
  readonly input: Schema.Json
  readonly ok: boolean
  readonly value: Schema.Json
  readonly message?: string | undefined
}

/**
 * Records one settled call.
 *
 * A call that failed carries what the flow said about the failure, because that
 * text — an anchor near-miss, a missing path — is the whole content of the
 * result and is otherwise seen only by a cell that thought to catch it.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const entry = (ordinal: number, call: Settlement): Entry =>
  new Entry({
    ordinal,
    flow: call.flow,
    subject: subject(call.input),
    ok: call.ok,
    digest: call.ok ? digest(call.value) : clip(call.message ?? "failed", width)
  })

/**
 * How many calls this run has settled, given a ledger some of whose lines have
 * aged out.
 *
 * The ledger holds at most {@link bound} lines, so its length stops being the
 * run's call count as soon as it fills. The newest entry's ordinal is the count
 * and does not, which is why ordinals are stored rather than rendered from an
 * index.
 *
 * @category conversions
 * @since 0.1.0
 * @slop
 */
export const settled = (ledger: Ledger): number => ledger.length === 0 ? 0 : ledger[ledger.length - 1]!.ordinal

/**
 * Folds one frame's settled calls into the run's ledger, newest last.
 *
 * Ordinals continue the run's own sequence, so the numbers a model reads stay
 * the numbers the journal would give the same calls after older lines have aged
 * out of the bound.
 *
 * @category combinators
 * @since 0.1.0
 * @slop
 */
export const remember = (known: Ledger, made: ReadonlyArray<Settlement>): Ledger => {
  const before = settled(known)
  const all = [...known, ...made.map((call, index) => entry(before + index + 1, call))]
  return all.length <= bound ? all : all.slice(all.length - bound)
}

/**
 * Renders the ledger for the state section, or nothing when the run has settled
 * no call yet.
 *
 * @category conversions
 * @since 0.1.0
 * @slop
 */
export const render = (ledger: Ledger): string | undefined => {
  if (ledger.length === 0) return undefined
  const total = settled(ledger)
  const elided = total - ledger.length
  const heading = elided === 0
    ? `Calls this run has settled (${total}), oldest first. You have already asked these — read them here instead of asking again:`
    : `Calls this run has settled (${total}), oldest first; the ${elided} oldest are not listed. You have already asked these — read them here instead of asking again:`
  const lines = ledger.map((line) =>
    `${line.ordinal}. ${line.flow} ${line.subject} — ${line.ok ? "ok" : "FAILED"}: ${line.digest}`
  )
  return `${heading}\n${lines.join("\n")}`
}
