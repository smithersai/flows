/**
 * The one canonical derivation of an ordinal allocation scope.
 *
 * Ordinal step identity has three components: the kind of durable operation
 * (an activity dispatch or an internal engine operation), the stable
 * declaration identity (the activity name, or a fixed internal label), and an
 * optional explicit idempotency component — a caller-declared string or a
 * {@link StepKey.ContentIdentity} object. Every ordinal counter in the engine
 * is keyed by the scope this module derives, and the scope is also folded
 * into the persisted key as `parentScope`, so two dispatches with distinct
 * declarations can never swap ordinals under a permuted fiber interleaving
 * (issues #73, #85, #98, #101).
 *
 * The derivation is injective: distinct `(kind, name, idempotency)` inputs
 * always produce distinct scopes. The name is length-prefixed so a name that
 * happens to contain the component separator cannot alias another
 * declaration, and both idempotency forms are canonicalized to a fixed-width
 * digest through one path — a string hashes directly, an object hashes via
 * `StepKey.content` — under distinct tags so a string can never alias the
 * object identity whose digest it happens to spell.
 *
 * Governing contract: `docs/specs/Concepts/Step Keys.md`.
 *
 * @since 0.1.0
 */
import * as Digest from "@smithers/keys/Digest"
import * as StepKey from "@smithers/keys/StepKey"
import * as Result from "effect/Result"

/**
 * The declaration material an allocation scope is derived from.
 *
 * @since 0.1.0
 * @category models
 */
export interface AllocationIdentity {
  /**
   * `"activity"` for user-declared activity dispatches, `"internal"` for
   * engine-owned durable operations (queue offers, deferred tokens). The two
   * kinds own disjoint counter namespaces.
   */
  readonly kind: "activity" | "internal"
  /**
   * The stable declaration identity: an activity's declared name, or a fixed
   * label for an internal operation family. Diagnostic names must not be
   * passed here unless they are part of identity.
   */
  readonly name: string
  /**
   * The explicit idempotency component. A declared string and a declared
   * content identity both refine the scope — two concurrent invocations of
   * one name with distinguishable inputs each own their own counter, so a
   * replay that reverses fiber-arrival order can never hand one invocation
   * the other's recorded outcome. Absent, invocations of one name share a
   * counter and remain allocation-ordered — indistinguishable declarations
   * have no material to order them by.
   */
  readonly idempotency?: string | StepKey.ContentIdentity | undefined
}

/**
 * Canonicalizes the idempotency component to a fixed-width tagged digest.
 *
 * Both forms pass through the same path: strings hash directly, objects hash
 * via the canonical `StepKey.content` encoding. The one-character tag keeps
 * the two forms disjoint even when a string happens to spell the other
 * form's digest.
 */
const idempotencyComponent = (
  idempotency: string | StepKey.ContentIdentity
): string =>
  typeof idempotency === "string"
    ? `s:${Digest.digest(idempotency)}`
    : `c:${Result.getOrThrow(StepKey.content(idempotency))}`

/**
 * Derives the ordinal allocation scope of a durable operation.
 *
 * The scope keys the operation's ordinal counter and is folded into its
 * persisted `StepKey.ordinal` key as `parentScope`, so identity is stable
 * under any interleaving of distinct declarations.
 *
 * Injectivity: the name is length-prefixed (`<kind>/<length>:<name>`), so a
 * name containing `/s:` or `/c:` material cannot collide with a keyed form
 * of a shorter name, and the idempotency component is a fixed-shape tagged
 * digest appended after the name.
 *
 * @since 0.1.0
 * @category derivations
 */
export const allocationScope = (identity: AllocationIdentity): string => {
  const base = `${identity.kind}/${identity.name.length}:${identity.name}`
  return identity.idempotency === undefined
    ? base
    : `${base}/${idempotencyComponent(identity.idempotency)}`
}
