/**
 * The durable engine composition every persistence example reuses.
 *
 * `EngineStore.layer` needs seven services: the journal and its three state
 * stores, the durable deferred/clock state, a kernel `Jj`, and a
 * `StepBoundary`. This module wires them over one SQLite file so a restart in
 * a later example reads the same rows a previous one wrote.
 */
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { DurableEngineState, EngineStore, StepBoundary } from "@smthrs/engine-store"
import { AttemptStore, CacheStore, Migrations, RunStore, SqlJournal } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

/**
 * A Jujutsu service that records nothing. The engine calls it for compensable
 * snapshots; the examples use sealed activities, so a stub keeps the wiring
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
  const database = Layer.provideMerge(Migrations.layer, NodeDatabase.layer({ filename }))
  return Layer.mergeAll(
    SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
    RunStore.layer,
    AttemptStore.layer,
    CacheStore.layer,
    DurableEngineState.layer
  ).pipe(Layer.provideMerge(database))
}

/**
 * Everything `EngineStore` requires, minus the engine itself.
 *
 * `isAlive` is the liveness probe the store consults before stealing a run
 * from a stale owner. Returning `false` means "that owner is gone, take the
 * run", which is correct for a single-process example and unsafe in a real
 * deployment.
 */
export const requirements = (filename: string) => Layer.mergeAll(storesLayer(filename), StepBoundary.layerTest(), stubJj)

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
