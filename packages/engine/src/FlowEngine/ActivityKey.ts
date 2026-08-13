// Deep reviewed and polished by a human on 2026-08-10.

/**
 * Derives the step identity an activity dispatch is recorded under.
 *
 * @private
 * @since 0.1.0
 */
import { Activity, Flow, StepIdentity } from "@smthrs/flow-next"
import { Key, type Key as KeyType } from "@smthrs/keys-next"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SchemaRepresentation from "effect/SchemaRepresentation"

/**
 * Extracts the hermetic boundary descriptor from an activity's metadata when
 * it is shaped like one (`readSet` digests, `writeSet`, `boundaryMode`).
 *
 * The descriptor is what gates cross-run cacheability, so it must be part of
 * the cache key (issue #25): a changed read-set digest, write set, or
 * boundary mode yields a different key and therefore a cache miss. The key
 * is only half of Skyframe's dirty→recheck→rebuild model, though: these
 * digests are caller-declared, so before a sealed hit is served the store
 * re-measures them through `StepBoundary.prepare` and refuses a hit whose
 * declaration no longer matches the host (issue #90). Metadata of any other
 * shape stays out of the key.
 */
const fileBoundary = (
  metadata: unknown
): Activity.FileBoundary | undefined =>
  Option.getOrUndefined(Schema.decodeUnknownOption(Activity.FileBoundary)(metadata))

/**
 * The ordinal allocation scope of an activity dispatch — its stable
 * declaration identity (issue #85), derived by the one canonical path in
 * `StepIdentity` (issue #101).
 *
 * The activity name always contributes (issue #73), and a declared
 * `idempotencyKey` refines the scope further — the string form and the
 * object form both, through the same canonicalization:
 * two concurrent invocations of one activity name with distinguishable
 * inputs declare distinct keys, so each owns its own counter and a replay
 * that reverses fiber-arrival order can never hand one invocation the
 * other's recorded outcome. Refining only the string form left object-keyed
 * activities on the name-only counter and exposed to exactly that swap.
 * Without a declared key, invocations of one name share a counter and
 * remain allocation-ordered — indistinguishable declarations have no
 * material to order them by.
 *
 * @private
 * @since 0.1.0
 */
export const ordinalScope = (
  activity: Activity.Any
): Effect.Effect<string, Schema.SchemaError, Crypto.Crypto> =>
  StepIdentity.allocationScope({
    kind: "activity",
    name: activity.name,
    idempotency: activity.idempotencyKey
  })

/**
 * A caller-declared identity carried material canonicalization rejects
 * (issue #151): the failure surfaces as a recorded typed completion — the
 * same channel `RetryPolicy`'s terminal errors use — naming the offending
 * path, instead of `Result.getOrThrow` killing the fiber with an untyped
 * defect. It is non-retryable by construction: the same declaration derives
 * the same rejection on every attempt, so no retry loop is entered and the
 * body never runs.
 *
 * @private
 * @since 0.1.0
 */
export const uncanonicalKey = (
  activityName: string,
  error: Schema.SchemaError
): Flow.Complete<never, never> =>
  new Flow.Complete({
    exit: Exit.die(
      new Activity.UncanonicalIdempotencyKey({
        activityName,
        reason: "canonicalize_failed",
        path: "$",
        message: error.message
      })
    )
  })

/**
 * A deterministic JSON form of an activity's declared success and error
 * schemas, derived from the schema ASTs through effect's stable
 * `SchemaRepresentation` document form. Folded into string-form sealed keys
 * so a changed declaration misses instead of decoding a stale cached row
 * under the new schema (issue #120).
 */
const declarationDigest = (activity: Activity.AnyWithProps): Schema.JsonObject => ({
  success: SchemaRepresentation.toJson(SchemaRepresentation.toRepresentation(activity.successSchema.ast)),
  error: SchemaRepresentation.toJson(SchemaRepresentation.toRepresentation(activity.errorSchema.ast))
})

/**
 * The persisted key an activity dispatch is recorded under: a pure cache key
 * for a keyed sealed activity, an ordinal-scoped invocation key otherwise.
 *
 * @private
 * @since 0.1.0
 */
export const activityKey = Effect.fn("FlowEngine.activityKey")(function*(
  activity: Activity.AnyWithProps,
  executionId: string,
  ordinal: number,
  environment: Activity.CacheEnvironment | undefined,
  scope: string
): Effect.fn.Return<KeyType, Schema.SchemaError, Crypto.Crypto> {
  if (activity.tier === "sealed" && activity.idempotencyKey !== undefined) {
    // Skyframe's SkyKey is (functionName, argument): a string idempotencyKey
    // is namespaced by the activity name so two distinct activities sharing an
    // idempotency string can never collide and replay each other's outcomes,
    // and the declared success/error schemas are folded in so the body is the
    // *compiled declaration* the step-key spec requires — a schema change
    // must miss rather than replay a stale row decoded under the new schema
    // (issue #120). The object form stays caller-owned (no
    // name and no schema material folded in) as the explicit, documented
    // escape hatch for rename- and refactor-stable identity. Note: folding
    // the declaration changes the digest of every persisted string-key row
    // from before this fix; those keys were unsafe to replay across schema
    // changes, so the break is intentional (same precedent as the
    // name-namespacing fix).
    // The two forms build `input` from different material, so the form itself
    // is key input. Without it a caller object that spells the string form's
    // `{activity, idempotencyKey, declaration}` encoding — the shape a caller
    // reaches for when copying the engine's own encoding to get a
    // rename-stable key — digests byte-identically to the string form, shares
    // one attempt row and one cache row, and replays the string form's
    // recorded outcome under its own schema. `StepIdentity.allocationScope`
    // already tags the same aliasing `/s:` and `/c:` (StepIdentity.ts:88-89);
    // the persisted key omitted it. The tag is a sibling of `input`, not a
    // member of it, so the caller-owned object stays verbatim and
    // rename-stability is untouched.
    const form = typeof activity.idempotencyKey === "string" ? "declared" : "caller"
    const input: Schema.JsonObject = typeof activity.idempotencyKey === "string"
      ? {
        activity: activity.name,
        idempotencyKey: activity.idempotencyKey,
        declaration: declarationDigest(activity)
      }
      : activity.idempotencyKey
    // The cacheability-gating boundary descriptor is cache key input
    // (issue #25): a changed read set, write set, or boundary mode must miss
    // rather than replay a stale cross-run cache entry. Both key forms fold
    // it through this one path — the caller-owned object keeps
    // rename-stability (no name enters the digest) but can never opt out of
    // the read-set material `ActivityPersistence` gates cacheability on
    // (issue #57): the descriptor derived from `activity.metadata` overrides
    // any caller-supplied `boundary` field.
    const boundary = fileBoundary(activity.metadata)
    // The caller-owned object can carry material canonicalization
    // rejects; the typed `SchemaError` propagates to the dispatch site
    // (issue #151) instead of being discarded through `Result.getOrThrow`.
    return yield* Schema.decodeUnknownEffect(Key)({
      kind: environment === undefined ? "run" : "cache",
      form,
      input,
      ...(environment === undefined ? { runId: executionId } : { environment }),
      ...(boundary === undefined ? {} : { boundary })
    })
  }
  // The ordinal is allocated from a counter scoped to this activity's
  // declaration identity and that scope is folded into the key as
  // `parentScope` (issues #73, #85). One per-run counter bumped in
  // fiber-arrival order made the identity of a compensable, irreversible, or
  // unsealed activity depend on scheduling: under `Effect.all` with
  // concurrency a replay could hand `chargeCard` the ordinal `sendEmail`
  // recorded and replay the wrong attempt rows, checkpoint, and outcome.
  // Per-identity counters are stable under any interleaving of distinct
  // declarations — distinct names, or one name with distinct declared
  // idempotency keys; the scope also keeps two identities from sharing the
  // number 1.
  return yield* StepIdentity.invocationKey({
    runId: executionId,
    parentScope: scope,
    ordinal,
    tier: activity.tier === "sealed" ? "unsealed" : activity.tier
  })
})
