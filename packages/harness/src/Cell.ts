/**
 * The cell contract.
 *
 * A Smithers frame is `model -> generated cell -> sandbox execution ->
 * individually durable flow calls -> next transition`. This module owns the
 * serializable half of that sentence: the cell source the model emits, the
 * transition the cell returns, the typed outcomes a cell may settle with, and
 * the identity carried by every flow call made inside one.
 *
 * Nothing here executes anything. Execution is `Sandbox`; durability is
 * `EngineLike.call`; the loop is `CellTurn`.
 *
 * Governing design: `docs/specs/Concepts/Durable Cell Loop.md` and
 * `docs/specs/Concepts/Agent Cell Context.md`.
 *
 * @since 0.1.0
 */
import * as Digest from "@smthrs/core/Digest"
import * as CanonicalJson from "@smthrs/model/CanonicalJson"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import * as Descriptor from "@smthrs/registry/Descriptor"
import { Effect, Option, Result, Schema } from "effect"

const NonNegativeSafeInt = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
)

/**
 * The source language a cell is written in.
 *
 * Both shipped bindings run a `typescript` cell by erasing its type-only
 * syntax — never by emitting new runtime behaviour, so a construct that needs
 * JavaScript emit is a `compile_failed` rejection rather than a silent
 * transform. A binding that cannot compile at all rejects with
 * `unsupported_language`; neither shipped binding needs to.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const Language = Schema.Literals(["javascript", "typescript"])

/**
 * The source language a cell is written in.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Language = typeof Language.Type

/**
 * One unit of agent-authored source and its stable content digest.
 *
 * The digest is part of every call identity produced inside the cell, so
 * editing one character of the source re-keys every boundary within it.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export class Source extends Schema.Class<Source>("flows/harness/Cell/Source")({
  language: Language,
  text: Schema.String,
  digest: Schema.String
}) {}

/**
 * Computes the stable digest of cell source.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const digestOf = (language: Language, text: string): string =>
  Digest.digest(CanonicalJson.stringify({ kind: "flows/harness/Cell/Source", language, text }))

/**
 * Constructs cell source with its computed digest.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const source = (text: string, language: Language = "javascript"): Source =>
  new Source({ language, text, digest: digestOf(language, text) })

/**
 * One projected message a cell places in the next model context.
 *
 * A cell owns its next context: it returns exactly the entries that survive
 * into the following frame, and the harness renders them. This keeps the
 * projection JSON-shaped so it crosses the sandbox boundary unchanged.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export class ContextEntry extends Schema.Class<ContextEntry>("flows/harness/Cell/ContextEntry")({
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String
}) {}

/**
 * Renders one projected context entry as a provider-neutral message.
 *
 * @category conversions
 * @since 0.1.0
 * @slop
 */
export const renderEntry = (entry: ContextEntry): ModelRequest.Message =>
  entry.role === "user"
    ? ModelRequest.Message.user(entry.text)
    : ModelRequest.Message.assistant(entry.text, { stopReason: "stop" })

/**
 * The cell asks for another frame, carrying its own durable state and the
 * exact context the next model call should see.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export class Continue extends Schema.TaggedClass<Continue>("flows/harness/Cell/Continue")("continue", {
  state: Schema.Json,
  context: Schema.Array(ContextEntry),
  /**
   * Why this frame changed nothing, when the controller demanded that it
   * either mutate or say why not.
   *
   * The field exists because prose in the prompt did not stop a run from
   * reading for its whole budget: a benchmark instance spent 100 frames and
   * 132 calls without one edit attempt and then claimed the fix was
   * implemented. A justification is the typed way out of the read-only cap —
   * it is recorded, it buys a bounded grace, and it does not reset the
   * counter that eventually stops the run.
   */
  justification: Schema.optional(Schema.String)
}) {}

/**
 * The cell declares the task finished and supplies its final output.
 *
 * A completion carries no self-reported proof. The run's evidence is the calls
 * it actually made — every one journaled as `cell-call-settled` with its real
 * input and result — and a field in which the model restates which of them
 * proved the work would be a claim about a check rather than the check.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export class Complete extends Schema.TaggedClass<Complete>("flows/harness/Cell/Complete")("complete", {
  state: Schema.Json,
  output: Schema.String,
  reason: Schema.optional(Schema.String)
}) {}

/**
 * The cell asks the controller to park the run durably.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export class Park extends Schema.TaggedClass<Park>("flows/harness/Cell/Park")("park", {
  state: Schema.Json,
  reason: Schema.Literals(["waiting-input", "waiting-event", "waiting-quota"]),
  message: Schema.String
}) {}

/**
 * The serializable decision one cell returns.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const Transition = Schema.Union([Continue, Complete, Park]).pipe(Schema.toTaggedUnion("_tag"))

/**
 * The serializable decision one cell returns.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Transition = typeof Transition.Type

/**
 * The wire shape a cell returns, before decoding into a {@link Transition}.
 *
 * A cell is plain JavaScript, so it returns a plain object keyed by `intent`
 * rather than Effect's `_tag`. Keeping the two apart means a malformed
 * transition is a decode failure with a message the model can act on, not a
 * crash.
 */
const Returned = Schema.Union([
  Schema.Struct({
    intent: Schema.Literal("continue"),
    state: Schema.optional(Schema.Json),
    context: Schema.Array(ContextEntry),
    justification: Schema.optional(Schema.String)
  }),
  Schema.Struct({
    intent: Schema.Literal("complete"),
    state: Schema.optional(Schema.Json),
    output: Schema.String,
    reason: Schema.optional(Schema.String)
  }),
  Schema.Struct({
    intent: Schema.Literal("park"),
    state: Schema.optional(Schema.Json),
    reason: Schema.Literals(["waiting-input", "waiting-event", "waiting-quota"]),
    message: Schema.String
  })
]).pipe(Schema.toTaggedUnion("intent"))

/**
 * Stable reasons a cell failed to produce a transition.
 *
 * Every one of these is a durable observation the model may correct on a later
 * frame; none of them is a harness crash.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const RejectionCode = Schema.Literals([
  "no_cell",
  "imports_forbidden",
  "compile_failed",
  "invalid_transition",
  "unsupported_language",
  "limit_exceeded",
  "stalled"
])

/**
 * Stable reasons a cell failed to produce a transition.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type RejectionCode = typeof RejectionCode.Type

/**
 * The cell ran and returned a well-formed transition.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export class Settled extends Schema.TaggedClass<Settled>("flows/harness/Cell/Settled")("settled", {
  transition: Transition
}) {}

/**
 * The cell ran and threw. The thrown value is projected into stable text so it
 * survives the journal and the next frame's context.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export class Raised extends Schema.TaggedClass<Raised>("flows/harness/Cell/Raised")("raised", {
  name: Schema.String,
  message: Schema.String
}) {}

/**
 * The cell never ran, or ran and returned something that is not a transition.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export class Rejected extends Schema.TaggedClass<Rejected>("flows/harness/Cell/Rejected")("rejected", {
  code: RejectionCode,
  message: Schema.String
}) {}

/**
 * Everything one cell evaluation may settle with.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const Outcome = Schema.Union([Settled, Raised, Rejected]).pipe(Schema.toTaggedUnion("_tag"))

/**
 * Everything one cell evaluation may settle with.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Outcome = typeof Outcome.Type

/**
 * Decodes the plain value a cell returned into a durable transition.
 *
 * @category conversions
 * @since 0.1.0
 * @slop
 */
export const transition = (value: unknown): Outcome => {
  const decoded = Schema.decodeUnknownResult(Returned)(value)
  if (decoded._tag === "Failure") {
    return new Rejected({
      code: "invalid_transition",
      message:
        "The cell did not return a transition. Return { intent: \"continue\" | \"complete\" | \"park\", ... } exactly as the contract describes."
    })
  }
  const returned = decoded.success
  switch (returned.intent) {
    case "continue":
      return new Settled({
        transition: new Continue({
          state: returned.state ?? null,
          context: returned.context,
          justification: returned.justification
        })
      })
    case "complete":
      return new Settled({
        transition: new Complete({
          state: returned.state ?? null,
          output: returned.output,
          reason: returned.reason
        })
      })
    case "park":
      return new Settled({
        transition: new Park({
          state: returned.state ?? null,
          reason: returned.reason,
          message: returned.message
        })
      })
  }
}

/**
 * The read-only projection of one callable flow handed to a cell.
 *
 * This is exactly what `ctx.flows` exposes: enough for the model to choose a
 * call and for the cell to reason about it, and nothing that carries authority.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export class FlowProjection extends Schema.Class<FlowProjection>("flows/harness/Cell/FlowProjection")({
  name: Schema.String,
  description: Schema.String,
  capabilities: Schema.Array(Schema.String),
  tier: Descriptor.EffectTier,
  placement: Schema.Option(Descriptor.Placement),
  /**
   * The call's input schema, as a JSON Schema document, when the descriptor
   * carries one by value.
   *
   * Without it a cell can only guess an input shape from prose, and every
   * guess costs a whole frame: a rejected call is one model turn, so learning
   * `bash` takes `{ command, mode, reads, writes }` cost four turns of pure
   * trial and error before any work began.
   */
  input: Schema.Option(Schema.Json).pipe(
    Schema.withConstructorDefault(Effect.succeed(Option.none())),
    Schema.withDecodingDefaultKey(Effect.succeed(Option.none()))
  )
}) {}

/**
 * Projects a discovered descriptor into the cell-visible catalog entry.
 *
 * @category conversions
 * @since 0.1.0
 * @slop
 */
export const project = (descriptor: Descriptor.FlowDescriptor): FlowProjection =>
  new FlowProjection({
    name: descriptor.name,
    description: descriptor.description,
    capabilities: descriptor.capabilities,
    tier: descriptor.effects.tier,
    placement: descriptor.placement,
    input: descriptor.input._tag === "Inline" ? Option.some(descriptor.input.document) : Option.none()
  })

/**
 * The complete identity of one flow call made inside one cell.
 *
 * Identity is what makes a mid-cell crash replayable. Re-executing the cell
 * source reaches the same lexical call in the same order with the same
 * declaration, so the boundary keys identically and replays; anything that
 * differs — a new frame, an edited cell, a different resolved layer set — keys
 * differently and executes.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export class CallIdentity extends Schema.Class<CallIdentity>("flows/harness/Cell/CallIdentity")({
  /** The durable session/lineage the frame belongs to. */
  session: Schema.String,
  /** The controller frame that produced the cell. */
  frame: NonNegativeSafeInt,
  /** The digest of the cell source being executed. */
  cell: Schema.String,
  /** The zero-based execution ordinal of this call within the cell. */
  ordinal: NonNegativeSafeInt,
  /** The digest of the resolved flow declaration being invoked. */
  declaration: Schema.String,
  /** The resolved layer set in effect at the boundary. */
  layers: Schema.Array(Schema.String)
}) {}

/**
 * Computes the declaration digest folded into a call identity.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const declarationDigest = (descriptor: Descriptor.FlowDescriptor): string =>
  Digest.digest(
    CanonicalJson.stringify({
      name: descriptor.name,
      capabilities: [...descriptor.capabilities].sort(),
      effects: descriptor.effects,
      placement: Option.getOrNull(descriptor.placement),
      body: descriptor.body.path,
      provenance: { source: descriptor.provenance.source, root: descriptor.provenance.root }
    })
  )

/**
 * One flow call requested from inside a cell.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export class Call extends Schema.Class<Call>("flows/harness/Cell/Call")({
  flowName: Schema.String,
  input: Schema.Json,
  capabilities: Schema.Array(Schema.String),
  effects: Descriptor.EffectDeclaration,
  placement: Schema.Option(Descriptor.Placement),
  identity: CallIdentity
}) {}

/**
 * The settled outcome of one flow call.
 *
 * A `failure` is data the cell may catch and recover from; it is never a
 * harness failure. Anything the cell cannot see — a permission park, an abort —
 * travels in the effect's error channel instead.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export class CallResult extends Schema.Class<CallResult>("flows/harness/Cell/CallResult")({
  outcome: Schema.Literals(["success", "failure"]),
  value: Schema.Json,
  message: Schema.optional(Schema.String)
}) {}

const fenced = /```(?<info>[^\n`]*)\n(?<body>[\s\S]*?)\n?```/g

const languageOf = (info: string): Language | undefined => {
  const tokens = info.trim().toLowerCase().split(/\s+/).filter((token) => token.length > 0)
  if (tokens.length === 0) return undefined
  for (const token of tokens) {
    if (token === "cell" || token === "js" || token === "javascript") return "javascript"
    if (token === "ts" || token === "typescript") return "typescript"
  }
  return undefined
}

/**
 * Detects a static or dynamic module import, which a cell may never use.
 *
 * The cell's only binding is the injected frozen context, so any import is a
 * contract violation reported back to the model rather than a resolution
 * attempt inside the sandbox.
 */
const importsSource = (text: string): boolean =>
  /(^|[^\w$.])import(?=[\s(*{'"`])/.test(text) ||
  /(^|[^\w$.])export(?=[\s{*])/.test(text) ||
  /(^|[^\w$.])require\s*\(/.test(text)

/**
 * Extracts the cell one model settlement emitted.
 *
 * The last fenced block tagged as a cell wins, so a model that reasons in prose
 * with illustrative snippets before committing to its final cell is read the
 * way it intended.
 *
 * @category conversions
 * @since 0.1.0
 * @slop
 */
export const extract = (text: string): Result.Result<Source, Rejected> => {
  let language: Language | undefined
  let body: string | undefined
  fenced.lastIndex = 0
  for (const match of text.matchAll(fenced)) {
    /* v8 ignore next -- `info` is a mandatory group of `fenced`, outside any alternation or quantifier, so it participates in every match; the default only discharges the optional type TypeScript gives `RegExpMatchArray.groups` */
    const candidate = languageOf(match.groups?.info ?? "")
    if (candidate === undefined) continue
    language = candidate
    /* v8 ignore next -- `body` is likewise mandatory in `fenced`; a match that reached here already produced `info`, so `groups` is present and carries both */
    body = match.groups?.body ?? ""
  }
  if (language === undefined || body === undefined) {
    return Result.fail(
      new Rejected({
        code: "no_cell",
        message:
          "No cell was found in the response. Emit exactly one fenced ```cell block containing the JavaScript for this transition."
      })
    )
  }
  if (importsSource(body)) {
    return Result.fail(
      new Rejected({
        code: "imports_forbidden",
        message:
          "A cell may not import, export, or require anything. Use ctx.call and ctx.flows; they are the only bindings available."
      })
    )
  }
  return Result.succeed(source(body, language))
}
