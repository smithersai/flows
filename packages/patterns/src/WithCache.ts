/**
 * Engine step-key cache decoration.
 *
 * @see docs/specs/Concepts/Injection And Decoration.md
 *
 * @since 0.1.0
 */
import { Flow } from "@smthrs/core"
import * as Duration from "effect/Duration"
import * as Option from "effect/Option"
import * as Compose from "./internal/Compose.ts"
import * as Pattern from "./Pattern.ts"
import { PatternError } from "./PatternError.ts"

/**
 * Cache declaration options.
 *
 * TTL is stable declaration material for engines which support expiring
 * content keys. This package owns no runtime cache.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Options {
  readonly ttl?: Duration.Input | undefined
}

const declaration = (inner: Flow.Any, options: Options): Flow.Any => {
  const details = Compose.details(inner)
  const effects = details.effects
  if (
    effects === undefined ||
    effects.mode !== "hermetic" ||
    (effects.tier !== undefined && effects.tier !== "sealed")
  ) {
    throw new PatternError({
      code: "invalid_decorator",
      message: "withCache requires an explicitly hermetic, sealed flow"
    })
  }
  const ttl = options.ttl === undefined
    ? undefined
    : Option.getOrElse(Duration.fromInput(options.ttl), () => {
      throw new PatternError({
        code: "invalid_decorator",
        message: "Cache TTL must be a valid Effect duration"
      })
    })
  if (ttl !== undefined && !Duration.isPositive(ttl)) {
    throw new PatternError({
      code: "invalid_decorator",
      message: "Cache TTL must be greater than zero"
    })
  }
  if (ttl !== undefined) {
    throw new PatternError({
      code: "invalid_decorator",
      message: "Cache TTL expiry requires an engine cache-policy surface"
    })
  }
  return Flow.make({
    name: `withCache(${Compose.displayName(inner)})`,
    description: details.description,
    input: details.input,
    output: details.output,
    capabilities: details.capabilities,
    effects,
    flows: [inner],
    body: (input) => Compose.call(inner, input)
  })
}

/**
 * Builds a sealed step-key cache decorator.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (options: Options = {}): Pattern.Decorator => (inner) => declaration(inner, options)

/**
 * Marks a sealable wrapper for engine step-key caching.
 *
 * Reuse remains an engine concern; this decorator allocates no map and keeps
 * no process-local state.
 *
 * @category combinators
 * @since 0.1.0
 * @slop
 */
export const withCache = (inner: Flow.Any, options: Options = {}): Flow.Any =>
  Compose.seal(Pattern.decorate(inner, make(options)))
