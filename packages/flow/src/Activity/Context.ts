// Deep reviewed and polished by a human on 2026-08-10.

/**
 * Defines runtime context carried across activity attempts.
 *
 * @since 0.1.0
 */
import * as Context from "effect/Context"
import * as Layer from "effect/Layer"
import type { CacheEnvironment } from "./CacheEnvironment.ts"

/**
 * Context reference carrying the complete environment folded into reusable
 * activity keys.
 *
 * A composition either provides a complete {@link CacheEnvironment} or leaves
 * it absent. When absent, the engine scopes activity keys to the current run
 * instead of presenting incomplete environment data as reusable identity.
 *
 * @category idempotency
 * @since 0.1.0
 */
export const CurrentCacheEnvironment = Context.Reference<CacheEnvironment | undefined>(
  "flows/engine/Activity/CurrentCacheEnvironment",
  { defaultValue: () => undefined }
)

/**
 * Declares the complete cache environment of a composition as a layer.
 *
 * **When to use**
 *
 * Use this only when the composition can identify every semantic runtime
 * layer and its complete capability set. Otherwise leave the context absent.
 *
 * @category idempotency
 * @since 0.1.0
 */
export const layerCacheEnvironment = (
  environment: CacheEnvironment
): Layer.Layer<never> => Layer.succeed(CurrentCacheEnvironment)(environment)

/**
 * The ordinal slots a retry sequence shares across its attempts, keyed by
 * allocation scope.
 *
 * `Activity.retry` cannot allocate ordinals itself — allocation is scoped by
 * activity identity and only the engine knows which activity is being
 * dispatched (issue #73) — so it provides an empty map the engine fills per
 * scope on the first attempt and reads back on every later one. The map is
 * scope-keyed rather than a single value because one retry block may
 * dispatch several distinct activities; a shared unkeyed slot handed the
 * first activity's ordinal to every later one, silently skipping their own
 * name-scoped counters and aliasing a later independent dispatch onto an
 * in-block key (issue #84).
 *
 * Each scope pins a *sequence* of ordinals rather than a single value
 * (issue #100): one retry block may dispatch the same declaration several
 * times, and a single-valued slot handed the first dispatch's ordinal to
 * every later one, so the second dispatch silently replayed the first's
 * recorded outcome. `cursors` counts the dispatches of each scope within the
 * current attempt — `Activity.retry` resets it at every attempt boundary —
 * so the n-th same-scope dispatch of every attempt reuses the n-th pinned
 * ordinal.
 *
 * @category attempts
 * @since 0.1.0
 */
export interface OrdinalSlot {
  readonly values: Map<string, Array<number>>
  readonly cursors: Map<string, number>
}

/**
 * Context reference carrying the ordinal slot of the enclosing
 * `Activity.retry` sequence, when present.
 *
 * @category attempts
 * @since 0.1.0
 */
export const CurrentOrdinal = Context.Reference<OrdinalSlot | undefined>(
  "flows/engine/Activity/CurrentOrdinal",
  { defaultValue: () => undefined }
)

/**
 * Context reference containing the current activity retry attempt, defaulting
 * to `1`.
 *
 * @category attempts
 * @since 4.0.0
 */
export const CurrentAttempt = Context.Reference<number>(
  "effect/flow/Activity/CurrentAttempt",
  { defaultValue: () => 1 }
)

/**
 * Context reference carrying the persisted key of the dispatch an
 * implementation is currently running under, when the runtime supplies one.
 *
 * **When to use**
 *
 * Use it in an activity implementation that has to name durable state of its
 * own — `Sleep` names a `DurableClock` — so the name it derives belongs to
 * THIS dispatch. The key is the identity the engine already allocated for the
 * dispatch: its attempt rows, its recorded outcome, and its cache row are
 * addressed by it, so it is stable across every replay of one node and
 * distinct between two identical calls of the same declaration. Deriving from
 * it is therefore the only way an implementation gets both properties without
 * allocating a second identity beside the engine's.
 *
 * **Gotchas**
 *
 * A runtime that has not adopted the seam leaves the reference absent rather
 * than substituting a placeholder, because a placeholder would silently alias
 * every dispatch of one declaration onto one name. An implementation that
 * needs durable identity refuses instead.
 *
 * @category idempotency
 * @since 0.1.0
 */
export const CurrentInvocationKey = Context.Reference<string | undefined>(
  "flows/engine/Activity/CurrentInvocationKey",
  { defaultValue: () => undefined }
)
