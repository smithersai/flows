/**
 * The two-tier step-cache protocol at the dispatch seam (issue #172).
 *
 * Two properties, both taken from Bazel's remote cache:
 *
 * - **Blobs before metadata.** `UploadManifest.java:630-633`: the action result
 *   is uploaded LAST, after every blob it references, because "action results
 *   may fail to validate server-side if they are accessed before all blobs they
 *   refer to are present". A publication that cannot make the artifacts durable
 *   must not record the entry.
 * - **Lazy download.** A shared row is routinely recorded on a machine whose
 *   artifacts this one has never seen, so "the blob is not here" is the normal
 *   first answer. The dispatch fetches, retries the replay ONCE, and otherwise
 *   falls through to a real execution rather than looping.
 */
import * as ArtifactStore from "@smthrs/artifacts/ArtifactStore"
import { Jj } from "@smthrs/kernel"
import { type Ownership, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { describe, expect, it } from "vitest"
import * as ArtifactSync from "../src/ArtifactSync.ts"
import * as ActivityPersistence from "../src/internal/ActivityPersistence.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { runPromise, sha256 } from "./Sha256.ts"

const owner: Ownership.OwnerId = { hostId: "remote-cache-host", pid: 42, nonce: "remote-cache-process" }

const declared: ActivityPersistence.BoundaryMetadata = {
  readSet: [{ path: "input.txt", digest: "D1" }],
  writeSet: ["artifact.bin"],
  boundaryMode: "hard"
}

const encoder = new TextEncoder()
const payload = encoder.encode("a referenced artifact")
const digest = sha256(payload)

const evidence: StepBoundary.BoundaryEvidence = {
  declaredOutputs: { outputs: [{ path: "artifact.bin", digest, sizeBytes: payload.length }] },
  diffIdentity: "remote-cache-diff",
  wholeTreeWritesVerified: true
}

/**
 * A boundary that always verifies its read set and always settles with the
 * digest-referencing evidence above, so the only variable under test is what
 * `replayOutputs` does.
 */
const boundaryLayer = (replayOutputs: StepBoundary.Service["replayOutputs"]) =>
  Layer.succeed(
    StepBoundary.StepBoundary,
    StepBoundary.make({
      prepare: (descriptor) => Effect.succeed({ descriptor, readSnapshot: descriptor.readSet }),
      settle: () => Effect.succeed(evidence),
      replayOutputs
    })
  )

const missingArtifact = Effect.fail(
  new StepBoundary.MissingArtifact({ code: "missing_artifact", path: "artifact.bin", digest })
)

const jjLayer = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ changeId: "remote-cache-snapshot" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

const activate = (runId: string) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    yield* runs.create(runId, "{}")
    const row = yield* runs.get(runId)
    const snapshot = { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs }
    const claim = yield* runs.claim(runId, snapshot, owner, 1)
    if (claim._tag !== "Claimed") return yield* Effect.die(new Error("claim lost"))
    const activated = yield* runs.activate(runId, owner, claim.claimedAtMs, snapshot)
    if (activated._tag !== "Activated") return yield* Effect.die(new Error("activation lost"))
  })

const dispatch = (runId: string, key: string, execute: () => Effect.Effect<unknown, unknown>) =>
  ActivityPersistence.make({ runId, owner, sourceId: `remote-cache-${runId}`, execute })({
    activity: {},
    attempt: 1,
    key,
    tier: "sealed",
    metadata: declared
  })

describe("blobs before metadata", () => {
  it("publishes every referenced artifact before the entry is recorded", async () => {
    const key = "remote-cache/publish"
    const local = ArtifactStore.makeMemory()
    const remote = ArtifactStore.makeMemory()
    const outcome = await runPromise(
      Effect.gen(function*() {
        const cache = yield* CacheStore.CacheStore
        yield* local.put(payload)
        yield* activate("publish-run")
        yield* dispatch("publish-run", key, () => Effect.succeed("recorded")).pipe(
          Effect.provide(boundaryLayer(() => Effect.void))
        )
        return {
          entry: yield* cache.get(sha256(key)),
          published: yield* remote.has(digest)
        }
      }).pipe(
        Effect.provideService(ArtifactSync.ArtifactSync, ArtifactSync.make({ local, remote })),
        Effect.provide(Layer.mergeAll(TestStores.layer(), jjLayer)),
        Effect.scoped
      )
    )
    expect(Option.isSome(outcome.entry)).toBe(true)
    expect(outcome.published).toBe(true)
  })

  it("records no entry when a referenced artifact cannot be published", async () => {
    // The entry must never become observable while an artifact it references
    // is missing: a sibling machine would get a hit it cannot materialize.
    const key = "remote-cache/publish-refused"
    const outcome = await runPromise(
      Effect.gen(function*() {
        const cache = yield* CacheStore.CacheStore
        yield* activate("publish-refused-run")
        const exit = yield* dispatch("publish-refused-run", key, () => Effect.succeed("recorded")).pipe(
          Effect.provide(boundaryLayer(() => Effect.void)),
          Effect.exit
        )
        return { exit, entry: yield* cache.get(sha256(key)) }
      }).pipe(
        Effect.provideService(
          ArtifactSync.ArtifactSync,
          // The local tier holds nothing, so the artifact this host claims to
          // have recorded cannot be read back and publication refuses.
          ArtifactSync.make({ local: ArtifactStore.makeMemory(), remote: ArtifactStore.makeMemory() })
        ),
        Effect.provide(Layer.mergeAll(TestStores.layer(), jjLayer)),
        Effect.scoped
      )
    )
    expect(outcome.exit._tag).toBe("Failure")
    expect(Option.isNone(outcome.entry)).toBe(true)
  })
})

describe("lazy download", () => {
  it("fetches a locally-missing artifact and retries the replay once", async () => {
    const key = "remote-cache/hydrate"
    const local = ArtifactStore.makeMemory()
    const remote = ArtifactStore.makeMemory()
    let executions = 0
    let replays = 0
    const body = () =>
      Effect.sync(() => {
        executions++
        return "recorded"
      })
    const outcome = await runPromise(
      Effect.gen(function*() {
        yield* local.put(payload)
        // The recording run publishes the artifact into the shared tier.
        yield* activate("hydrate-producer")
        yield* dispatch("hydrate-producer", key, body).pipe(Effect.provide(boundaryLayer(() => Effect.void)))
        // The consuming run's host has never seen the artifact: the first
        // replay refuses, hydration fetches it, and the retry succeeds.
        yield* activate("hydrate-consumer")
        const result = yield* dispatch("hydrate-consumer", key, body).pipe(
          Effect.provide(
            boundaryLayer(() =>
              Effect.suspend(() => {
                replays++
                return replays === 1 ? missingArtifact : Effect.void
              })
            )
          )
        )
        return result
      }).pipe(
        Effect.provideService(ArtifactSync.ArtifactSync, ArtifactSync.make({ local, remote })),
        Effect.provide(Layer.mergeAll(TestStores.layer(), jjLayer)),
        Effect.scoped
      )
    )
    expect(outcome).toBe("recorded")
    // The consuming run was a cache hit: its body never ran.
    expect(executions).toBe(1)
    expect(replays).toBe(2)
  })

  it("falls through to a real execution when the shared tier cannot serve the artifact either", async () => {
    const key = "remote-cache/hydrate-exhausted"
    let executions = 0
    let replays = 0
    const body = () =>
      Effect.sync(() => {
        executions++
        return "recorded"
      })
    // A shared tier that already holds the artifact — so publication is
    // trivially satisfied — but cannot serve it back.
    const remote = ArtifactStore.makeNoop({ findMissing: () => Effect.succeed([]) })
    await runPromise(
      Effect.gen(function*() {
        yield* activate("exhausted-producer")
        yield* dispatch("exhausted-producer", key, body).pipe(Effect.provide(boundaryLayer(() => Effect.void)))
        yield* activate("exhausted-consumer")
        yield* dispatch("exhausted-consumer", key, body).pipe(
          Effect.provide(
            boundaryLayer(() =>
              Effect.suspend(() => {
                replays++
                return missingArtifact
              })
            )
          )
        )
      }).pipe(
        Effect.provideService(
          ArtifactSync.ArtifactSync,
          // Hydration reports failure rather than failing the run, and the
          // dispatch does the work for real.
          ArtifactSync.make({ local: ArtifactStore.makeMemory(), remote })
        ),
        Effect.provide(Layer.mergeAll(TestStores.layer(), jjLayer)),
        Effect.scoped
      )
    )
    expect(executions).toBe(2)
    // Exactly one refusal: hydration failed, so the replay is never retried.
    expect(replays).toBe(1)
  })
})
