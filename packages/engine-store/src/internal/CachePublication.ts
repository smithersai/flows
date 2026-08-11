/**
 * The two-tier step-cache protocol, extracted out of `ActivityPersistence`.
 *
 * `ActivityPersistence` owns *when* a result may be shared — sealed tier, hard
 * boundary, no deviation, verified read set. This module owns *how* it becomes
 * shareable and how a shared hit is made replayable, which is the half a
 * two-tier composition has to be able to inject into:
 *
 * - {@link publishArtifacts} runs before the cache entry is written, so an
 *   entry is never observable while an artifact it references is missing
 *   (`reference/bazel/.../remote/UploadManifest.java:630-633`).
 * - {@link hydrateArtifacts} runs after a replay refused for a *missing*
 *   artifact — the one refusal a shared tier can repair — so the replay is
 *   retried once against fetched bytes instead of falling straight through to
 *   a real execution.
 *
 * The seam is `ArtifactSync`, resolved optionally: a composition with no
 * shared tier gets `ArtifactSync.makeLocal()`, whose `publish` is a no-op and
 * whose `hydrate` reports nothing was fetched. That is why a purely local
 * engine pays nothing for this file.
 *
 * Blob I/O stays OUTSIDE the `DurableWriter` transaction, like the Jj snapshot
 * and the boundary prepare/settle: a host call must never be held across a
 * write transaction.
 *
 * @since 0.1.0
 */
import * as Cause from "effect/Cause"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as ArtifactSync from "../ArtifactSync.ts"
import * as StepBoundary from "../StepBoundary.ts"

/** Resolves the configured protocol, defaulting to the single-tier one. */
const sync: Effect.Effect<ArtifactSync.Service> = Effect.map(
  Effect.serviceOption(ArtifactSync.ArtifactSync),
  (configured) => Option.isSome(configured) ? configured.value : ArtifactSync.makeLocal()
)

/**
 * Makes every artifact the evidence references durable in the shared tier.
 *
 * Called immediately before the transaction that records the cache entry, and
 * never inside it.
 *
 * @since 0.1.0
 * @category protocol
 */
export const publishArtifacts = (
  evidence: StepBoundary.BoundaryEvidence | undefined
): Effect.Effect<void, ArtifactSync.ArtifactPublicationFailed, Crypto.Crypto> =>
  Effect.gen(function*() {
    if (evidence === undefined) return
    const digests = StepBoundary.referencedDigests(evidence)
    if (digests.length === 0) return
    const protocol = yield* sync
    yield* protocol.publish(digests)
  })

/**
 * Fetches the artifacts a replay could not resolve locally, reporting whether
 * the replay is now worth retrying.
 *
 * @since 0.1.0
 * @category protocol
 */
export const hydrateArtifacts = (
  evidence: StepBoundary.BoundaryEvidence
): Effect.Effect<boolean, never, Crypto.Crypto> =>
  Effect.gen(function*() {
    const digests = StepBoundary.referencedDigests(evidence)
    if (digests.length === 0) return false
    const protocol = yield* sync
    return yield* protocol.hydrate(digests)
  })

/**
 * The classification a `replayOutputs` failure needs before it can be
 * repaired: a {@link StepBoundary.MissingArtifact} means the bytes are simply
 * not on this host, which a shared tier may fix. Anything else — a corrupt
 * address, a host refusal — is not a fetchable condition.
 *
 * @since 0.1.0
 * @category protocol
 */
export const replayMissingArtifact = (
  cause: Cause.Cause<unknown>
): StepBoundary.MissingArtifact | undefined => {
  for (const reason of cause.reasons) {
    if (Cause.isFailReason(reason) && reason.error instanceof StepBoundary.MissingArtifact) {
      return reason.error
    }
  }
  return undefined
}
