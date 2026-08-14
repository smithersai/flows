/**
 * The durable engine composition every persistence example reuses.
 *
 * `EngineStore.layer` needs the journal and its three state stores, the
 * durable deferred/clock state, a kernel `Jj`, a `StepBoundary`, and — to make
 * sealed results shareable — a `WorkspaceSandbox`. This module wires them over
 * one SQLite file so a restart in a later example reads the same rows a
 * previous one wrote.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as ArtifactStore from "@smthrs/artifacts-next/ArtifactStore"
import { DurableWriter } from "@smthrs/database-next"
import * as NodeDatabase from "@smthrs/database-next/node/NodeDatabase"
import { DurableEngineState, EngineStore, OwnerIdentity, StepBoundary, WorkspaceSandbox } from "@smthrs/engine-store-next"
import * as Migrations from "@smthrs/engine-store-next/Migrations"
import { AttemptStore, RunStore } from "@smthrs/run-store-next"
import { CacheStore } from "@smthrs/step-cache-next"
import { SqlJournal } from "@smthrs/journal-next"
import { Jj, Workspace } from "@smthrs/kernel-next"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { dirname, join } from "node:path"

/**
 * A Jujutsu service that records nothing. The engine calls it for compensable
 * snapshots; the examples use sealed actions, so a stub keeps the wiring
 * honest without requiring a jj binary.
 */
export const stubJj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ changeId: "examples-snapshot" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

/** Journal, run, attempt, and cache stores over one migrated SQLite file. */
export const storesLayer = (filename: string) => {
  const database = Layer.provideMerge(
    Migrations.layer,
    Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename }))
  )
  return Layer.mergeAll(
    SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
    RunStore.layer,
    AttemptStore.layer,
    CacheStore.layer,
    DurableEngineState.layer
  ).pipe(Layer.provideMerge(database))
}

/**
 * The workspace an example's actions read and write. It defaults to the
 * directory holding the SQLite file, so a temp-file example is confined to its
 * own temp directory.
 */
const workspaceRoot = (filename: string) => dirname(filename)

/**
 * The host half: a real filesystem, a content-addressed artifact store inside
 * the workspace, and the workspace root itself.
 *
 * The store's directory is passed explicitly. `ArtifactStore.layerFileSystem`
 * does not read the kernel `Workspace` tag — its default `.flows/objects` is
 * resolved by the filesystem, which means the process's current directory —
 * so leaving it out would scatter an example's blobs wherever it happened to
 * be run from instead of into the temp workspace it just made.
 */
const hostLayer = (filename: string) =>
  ArtifactStore.layerFileSystem({ directory: join(workspaceRoot(filename), ".flows/objects") }).pipe(
    Layer.provideMerge(Workspace.layer(workspaceRoot(filename))),
    Layer.provideMerge(NodeFileSystem.layer)
  )

/**
 * Everything `EngineStore` requires, minus the engine itself.
 *
 * The boundary and the sandbox are the PRODUCTION layers — `StepBoundary.layer`
 * and `WorkspaceSandbox.layerFileSystem`, not `StepBoundary.layerTest`. That
 * pairing is what makes a sealed action's result eligible for the shared
 * step cache: the sandbox runs the body in an isolated workspace and observes
 * the whole tree, so the boundary evidence can honestly claim
 * `wholeTreeWritesVerified`. With `layerTest` the claim was a test fixture and
 * nothing composed this way ever reached the cache.
 *
 * `isAlive` is the liveness probe the store consults before stealing a run
 * from a stale owner. Returning `false` means "that owner is gone, take the
 * run", which is correct for a single-process example and unsafe in a real
 * deployment.
 *
 * `OwnerIdentity.layer` is the default owner minter — the process id plus a
 * fresh nonce. It is listed here rather than assumed because it is the seam a
 * host with a better answer replaces.
 */
export const requirements = (filename: string) =>
  Layer.mergeAll(
    storesLayer(filename),
    StepBoundary.layer,
    WorkspaceSandbox.layerFileSystem(),
    stubJj,
    OwnerIdentity.layer
  ).pipe(
    // `OwnerIdentity.layer` consumes Crypto while it is built, and action
    // keys/boundaries consume the same service later at execution time.
    // `provideMerge` does both: it satisfies construction and keeps Crypto in
    // the resulting engine environment. A sibling in `mergeAll` would expose
    // Crypto without feeding it to the owner layer.
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provideMerge(hostLayer(filename))
  )

/**
 * A durable `FlowEngine` over the SQLite file at `filename`.
 *
 * The stores are merged into the output rather than hidden, so an example can
 * read the journal or a run row back after executing a flow.
 */
export const durableEngine = (filename: string, hostId: string) =>
  EngineStore.layer({
    owner: { hostId },
    journalSource: `${hostId}-engine`,
    isAlive: () => Effect.succeed(false)
  }).pipe(Layer.provideMerge(requirements(filename)))
