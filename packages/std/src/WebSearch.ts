/**
 * Governing plan:
 * `docs/specs/Research/Agent Ecosystem Plan 2026-07-28.md`.
 *
 * @since 0.1.0
 */
import * as Flow from "@smthrs/core/Flow"
import { Context, Effect, Layer, Schema } from "effect"
import { capability, envelope } from "./internal/Declaration.ts"
import * as StdError from "./StdError.ts"

/** @category identifiers @since 0.1.0 */
export const name = "websearch"
/** @category descriptions @since 0.1.0 */
export const description = "Search the web through a configured provider and return normalized results."
/** @category schemas @since 0.1.0 */
export const Input = Schema.Struct({
  query: Schema.NonEmptyString,
  numResults: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 }))),
  freshness: Schema.optional(Schema.Literals(["day", "week", "month", "year"]))
})
/** @category schemas @since 0.1.0 */
export const Result = Schema.Struct({
  title: Schema.String,
  url: Schema.String,
  snippet: Schema.String,
  publishedAt: Schema.optional(Schema.String)
})
/** @category schemas @since 0.1.0 */
export const Output = Schema.Struct({ results: Schema.Array(Result) })
/** @category effects @since 0.1.0 */
export const effects = envelope({ tier: "sealed", mode: "expected", reads: [], writes: [] })
/** @category effects @since 0.1.0 */
export const effectsFor = (_input: typeof Input.Type) => effects
/** @category capabilities @since 0.1.0 */
export const capabilities = [capability("net:post", "*")]
/** @category flows @since 0.1.0 */
export const flow = Flow.make({ name, description, input: Input, output: Output, capabilities, effects })

/** @category services @since 0.1.0 */
export interface WebSearch {
  readonly search: (input: typeof Input.Type) => Effect.Effect<typeof Output.Type, StdError.StdError>
}
/** @category services @since 0.1.0 */
export const WebSearch: Context.Service<WebSearch, WebSearch> = Context.Service("/std/WebSearch")
/** @category constructors @since 0.1.0 */
export const make = (service: WebSearch): WebSearch => WebSearch.of(service)
/** @category constructors @since 0.1.0 */
export const makeNoop = (): WebSearch =>
  make({
    search: () =>
      Effect.fail(
        new StdError.StdError({ code: "provider_unavailable", message: "No web search provider is configured" })
      )
  })
/** @category layers @since 0.1.0 */
export const layerNoop: Layer.Layer<WebSearch> = Layer.succeed(WebSearch, makeNoop())
/** @category handlers @since 0.1.0 */
export const run = (input: typeof Input.Type): Effect.Effect<typeof Output.Type, StdError.StdError, WebSearch> =>
  Effect.flatMap(WebSearch, (provider) => provider.search(input))
