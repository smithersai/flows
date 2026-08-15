/**
 * The trampoline outcomes a link can end with.
 *
 * `done` completes the chain, `to` hands off to a successor script, and
 * `park` suspends the lineage with a typed waiting reason. There is no
 * agent-loop object: continuation is whatever the script returns
 * (`docs/specs/Concepts/Trampoline Loops.md`,
 * `docs/specs/Concepts/Chain Slice.md`).
 *
 * @since 0.1.0
 */
import { Schema } from "effect"
import * as Script from "./Script.ts"

/** @category models @since 0.1.0 */
export const ParkCode = Schema.Literals(["approval", "event", "timer", "quota", "plugin"])

/** @category models @since 0.1.0 */
export type ParkCode = typeof ParkCode.Type

/** @category models @since 0.1.0 */
export const ParkReason = Schema.Struct({
  code: ParkCode,
  message: Schema.String
})

/** @category models @since 0.1.0 */
export type ParkReason = typeof ParkReason.Type

/** @category models @since 0.1.0 */
export const Done = Schema.TaggedStruct("Done", { value: Schema.Json })

/** @category models @since 0.1.0 */
export type Done = typeof Done.Type

/** @category models @since 0.1.0 */
export const To = Schema.TaggedStruct("To", { script: Script.Script })

/** @category models @since 0.1.0 */
export type To = typeof To.Type

/** @category models @since 0.1.0 */
export const Park = Schema.TaggedStruct("Park", { reason: ParkReason })

/** @category models @since 0.1.0 */
export type Park = typeof Park.Type

/** @category models @since 0.1.0 */
export const Outcome = Schema.Union([Done, To, Park])

/** @category models @since 0.1.0 */
export type Outcome = typeof Outcome.Type

/**
 * A chain-ending outcome: parked lineages stop (wake is out of the slice's
 * scope) and completed lineages return their value.
 *
 * @category models
 * @since 0.1.0
 */
export type Terminal = Done | Park

/** @category constructors @since 0.1.0 */
export const done = (value: typeof Schema.Json.Type): Done => ({ _tag: "Done", value: value ?? null })

/** @category constructors @since 0.1.0 */
export const to = (script: Script.Script): To => ({ _tag: "To", script })

/** @category constructors @since 0.1.0 */
export const park = (code: ParkCode, message = ""): Park => ({ _tag: "Park", reason: { code, message } })
