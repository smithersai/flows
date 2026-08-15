/**
 * The journal event vocabulary of a chain, and the pure folds over it.
 *
 * The journal is the only state. The call cache used for replay, the
 * observation context handed to recovery author calls, and the terminal
 * verdict are all pure folds over the event array — nothing else is stored
 * anywhere (`docs/specs/Concepts/Chain Slice.md`).
 *
 * @since 0.1.0
 */
import { Schema } from "effect"
import * as CallKey from "./CallKey.ts"
import * as Observation from "./Observation.ts"
import * as Outcome from "./Outcome.ts"
import * as Script from "./Script.ts"

/**
 * The chain a scoped event belongs to. Omitted at the root — existing
 * journals stay byte-identical — and set to the deterministic child id
 * (`parent-chain/link.ordinal`) for sub-chain events.
 *
 * @category models
 * @since 0.1.0
 */
const scoped = { chain: Schema.optional(Schema.String) }

/** @category models @since 0.1.0 */
export const ChainStarted = Schema.TaggedStruct("ChainStarted", {
  ...scoped,
  goal: Schema.String,
  envelope: Schema.Json
})

/** @category models @since 0.1.0 */
export type ChainStarted = typeof ChainStarted.Type

/** @category models @since 0.1.0 */
export const LinkAuthored = Schema.TaggedStruct("LinkAuthored", {
  ...scoped,
  link: CallKey.LinkId,
  script: Script.Script
})

/** @category models @since 0.1.0 */
export type LinkAuthored = typeof LinkAuthored.Type

/** @category models @since 0.1.0 */
export const CallSettled = Schema.TaggedStruct("CallSettled", {
  ...scoped,
  link: CallKey.LinkId,
  key: CallKey.CallKey,
  name: Schema.String,
  payload: Schema.Json,
  result: Schema.Json
})

/** @category models @since 0.1.0 */
export type CallSettled = typeof CallSettled.Type

/** @category models @since 0.1.0 */
export const GateRejected = Schema.TaggedStruct("GateRejected", {
  ...scoped,
  link: CallKey.LinkId,
  ordinal: CallKey.Ordinal,
  observation: Observation.Observation
})

/** @category models @since 0.1.0 */
export type GateRejected = typeof GateRejected.Type

/** @category models @since 0.1.0 */
export const LinkEnded = Schema.TaggedStruct("LinkEnded", {
  ...scoped,
  link: CallKey.LinkId,
  outcome: Outcome.Outcome
})

/** @category models @since 0.1.0 */
export type LinkEnded = typeof LinkEnded.Type

/**
 * One non-empty steering drain, tied to the live author call it fed —
 * the nondeterministic boundary of the cell loop's RecordBoundary lesson,
 * journaled so a re-executed attempt reuses the recorded lines. Empty
 * drains are not journaled: a settled author call already pins its
 * context in its `CallSettled` payload.
 *
 * @category models
 * @since 0.1.0
 */
export const SteeringDrained = Schema.TaggedStruct("SteeringDrained", {
  ...scoped,
  link: CallKey.LinkId,
  ordinal: CallKey.Ordinal,
  messages: Schema.Array(Schema.String)
})

/** @category models @since 0.1.0 */
export type SteeringDrained = typeof SteeringDrained.Type

/** @category models @since 0.1.0 */
export const Event = Schema.Union([ChainStarted, LinkAuthored, CallSettled, GateRejected, LinkEnded, SteeringDrained])

/** @category models @since 0.1.0 */
export type Event = typeof Event.Type

/**
 * Whether an event belongs to the given chain scope.
 *
 * @category folds
 * @since 0.1.0
 */
export const inChain = (event: Event, chain: string): boolean => (event.chain ?? "") === chain

/**
 * Whether the chain has recorded its `ChainStarted` event.
 *
 * @category folds
 * @since 0.1.0
 */
export const started = (events: ReadonlyArray<Event>, chain = ""): boolean =>
  events.some((event) => event._tag === "ChainStarted" && inChain(event, chain))

/**
 * The index of the current link: links end strictly in order, so the count
 * of `LinkEnded` events names the link now in progress.
 *
 * @category folds
 * @since 0.1.0
 */
export const linkCount = (events: ReadonlyArray<Event>, chain = ""): number =>
  events.filter((event) => event._tag === "LinkEnded" && inChain(event, chain)).length

/**
 * The script authored for a link, if any. Link 0 (bootstrap) never has one.
 *
 * @category folds
 * @since 0.1.0
 */
export const authored = (events: ReadonlyArray<Event>, link: number, chain = ""): Script.Script | undefined => {
  for (const event of events) {
    if (event._tag === "LinkAuthored" && event.link === link && inChain(event, chain)) return event.script
  }
  return undefined
}

/**
 * The settled calls of a link, keyed by ordinal — the replay cache.
 *
 * @category folds
 * @since 0.1.0
 */
export const settled = (events: ReadonlyArray<Event>, link: number, chain = ""): ReadonlyMap<number, CallSettled> => {
  const calls = new Map<number, CallSettled>()
  for (const event of events) {
    if (event._tag === "CallSettled" && event.link === link && inChain(event, chain)) {
      calls.set(event.key.ordinal, event)
    }
  }
  return calls
}

/**
 * The gate rejections of a link, keyed by ordinal — replayed as aborts so a
 * resumed link never re-executes a rejected call.
 *
 * @category folds
 * @since 0.1.0
 */
export const rejected = (events: ReadonlyArray<Event>, link: number, chain = ""): ReadonlyMap<number, GateRejected> => {
  const rejections = new Map<number, GateRejected>()
  for (const event of events) {
    if (event._tag === "GateRejected" && event.link === link && inChain(event, chain)) {
      rejections.set(event.ordinal, event)
    }
  }
  return rejections
}

/**
 * All observations recorded for a link, in journal order — the material a
 * recovery author call projects into its context.
 *
 * @category folds
 * @since 0.1.0
 */
export const observations = (
  events: ReadonlyArray<Event>,
  link: number,
  chain = ""
): ReadonlyArray<Observation.Observation> =>
  events.flatMap((event) =>
    event._tag === "GateRejected" && event.link === link && inChain(event, chain) ? [event.observation] : []
  )

/**
 * Every steering line recorded for a link, in drain order. Steering is
 * link-cumulative: once drained into a link it reaches every subsequent
 * author attempt of that link, so a rejected attempt never swallows the
 * user's instruction.
 *
 * @category folds
 * @since 0.1.0
 */
export const steeringLines = (events: ReadonlyArray<Event>, link: number, chain = ""): ReadonlyArray<string> =>
  events.flatMap((event) =>
    event._tag === "SteeringDrained" && event.link === link && inChain(event, chain) ? event.messages : []
  )

/**
 * The ordinals of a link's recorded drains — a resumed execution never
 * re-drains a boundary it already consumed.
 *
 * @category folds
 * @since 0.1.0
 */
export const steeredOrdinals = (events: ReadonlyArray<Event>, link: number, chain = ""): ReadonlySet<number> =>
  new Set(
    events.flatMap((event) =>
      event._tag === "SteeringDrained" && event.link === link && inChain(event, chain) ? [event.ordinal] : []
    )
  )

/**
 * The chain's terminal outcome, if it has one: the last `LinkEnded` whose
 * outcome is `Done` or `Park`. A replay of a finished chain returns this
 * without executing anything.
 *
 * @category folds
 * @since 0.1.0
 */
export const terminal = (events: ReadonlyArray<Event>, chain = ""): Outcome.Terminal | undefined => {
  const last = [...events].reverse().find(
    (event): event is LinkEnded => event._tag === "LinkEnded" && inChain(event, chain)
  )
  if (last === undefined) return undefined
  return last.outcome._tag === "To" ? undefined : last.outcome
}
