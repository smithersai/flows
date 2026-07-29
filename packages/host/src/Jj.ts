/**
 * @since 0.1.0
 *
 * The `Jj` service: version control as a Host capability.
 *
 * `flows` snapshots the working copy around every step, so jj is not a tool the
 * agent happens to call — it is host access, and it goes through a layer like
 * every other. Contract only; module shape follows `effect/FileSystem`.
 */
import { Context, Effect, Layer } from "effect"
import { jjError } from "./HostError.ts"
import type { JjError } from "./HostError.ts"

/**
 * A jj change id — the durable handle a run uses to name workspace state.
 * @category models
 */
export type ChangeId = string

/** @category services */
export interface Jj {
  /** Commits the working copy and returns the change id to restore to later. */
  readonly snapshot: (message?: string) => Effect.Effect<{ readonly changeId: ChangeId }, JjError>
  /** Puts the working copy back to `changeId`. */
  readonly restore: (changeId: ChangeId) => Effect.Effect<void, JjError>
  /** Unified diff between two revisions. */
  readonly diff: (from: ChangeId, to: ChangeId) => Effect.Effect<string, JjError>
  /** Adds a named workspace rooted at `path` — one lane per parallel agent. */
  readonly workspaceAdd: (name: string, path: string) => Effect.Effect<void, JjError>
  readonly workspaceForget: (name: string) => Effect.Effect<void, JjError>
  readonly status: () => Effect.Effect<string, JjError>
}

/**
 * @category services
 * @since 0.1.0
 */
export const Jj: Context.Service<Jj, Jj> = Context.Service("flows/host/Jj")

/** @category constructors */
export const make = (impl: Jj): Jj => Jj.of(impl)

/**
 * Creates a stub `Jj` for tests. Every method fails with `JjError`
 * `not_installed` until overridden.
 *
 * @category constructors
 */
export const makeNoop = (overrides: Partial<Jj>): Jj => {
  const missing = (method: string) =>
    Effect.fail(
      jjError({ code: "not_installed", method, description: "jj is not available on this host" })
    )
  return Jj.of({
    snapshot: () => missing("snapshot"),
    restore: () => missing("restore"),
    diff: () => missing("diff"),
    workspaceAdd: () => missing("workspaceAdd"),
    workspaceForget: () => missing("workspaceForget"),
    status: () => missing("status"),
    ...overrides
  })
}

/** @category layers */
export const layerNoop = (overrides: Partial<Jj>): Layer.Layer<Jj> => Layer.succeed(Jj)(makeNoop(overrides))
