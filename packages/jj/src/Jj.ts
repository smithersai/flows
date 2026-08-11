/**
 * @since 0.1.0
 *
 * The `Jj` service: version control as a Host capability.
 *
 * `flows` snapshots the working copy around every step, so jj is not a tool the
 * agent happens to call — it is host access, and it goes through a layer like
 * every other. Contract only; module shape follows `effect/FileSystem`.
 *
 * The error lives here rather than in a shared host error module so that a
 * consumer who only snapshots a working copy does not pull in a process
 * spawner or an HTTP client. The one thing this package does import is
 * `@smthrs/capability`, the leaf that names the permission failures a guarded
 * `Jj` adds; it depends on nothing but `effect` either.
 *
 * The tag key and the error `_tag` are durable identity: step keys digest the
 * resolved service set, and `JjError` round-trips through the journal, so
 * renaming either invalidates recorded runs.
 */
import type * as Permission from "@smthrs/capability/Permission"
import { Context, Effect, Layer, Schema } from "effect"
import type { PlatformError } from "effect/PlatformError"

/** @category models */
export const JjErrorCode = Schema.Literals(["not_installed", "conflict", "invalid_ref", "unknown"])

/** @category models */
export type JjErrorCode = typeof JjErrorCode.Type

/**
 * A jj failure, shaped after `effect/PlatformError`: a stable `code` reason,
 * the `module` and `method` that failed, and a human `message`.
 *
 * Codes are a STABLE public contract: callers branch on them, step keys digest
 * them, UIs map them to remediation. Never repurpose a code — add one.
 *
 * @category models
 */
export class JjError extends Schema.TaggedErrorClass<JjError>()("@smthrs/jj/JjError", {
  code: JjErrorCode,
  module: Schema.optional(Schema.String),
  method: Schema.optional(Schema.String),
  message: Schema.String,
  /** The jj command that produced the failure, when one was run. */
  command: Schema.optional(Schema.String)
}) {}

/**
 * Creates a `JjError` from a failed jj operation.
 * @category constructors
 */
export const jjError = (options: {
  readonly code: JjErrorCode
  readonly module?: string | undefined
  readonly method: string
  readonly description?: string | undefined
  readonly command?: string | undefined
}): JjError => {
  const module = options.module ?? "Jj"
  return new JjError({
    code: options.code,
    module,
    method: options.method,
    message: `${options.code}: ${module}.${options.method}${options.description ? `: ${options.description}` : ""}`,
    command: options.command
  })
}

/**
 * Refines a failure to jj's own error, so a caller can tell "jj said no" from
 * "the capability kernel said no" without matching on `_tag` by hand.
 * @category refinements
 */
export const isJjError = (error: unknown): error is JjError =>
  typeof error === "object" && error !== null && "_tag" in error && error._tag === "@smthrs/jj/JjError"

/**
 * A jj change id — the durable handle a run uses to name workspace state.
 * @category models
 */
export type ChangeId = string

/**
 * Everything a `Jj` operation can fail with.
 *
 * `flows` runs jj behind the capability kernel, so the honest error channel of
 * this contract is jj's own failure *plus* the three the kernel adds. The
 * interface declares them here, in the package that owns the service, rather
 * than being redeclared and re-tagged by `@smthrs/kernel`: one interface, one
 * tag, and a caller that holds `Jj` cannot forget a snapshot may be denied.
 *
 * `@smthrs/capability` is a leaf that depends on nothing but `effect`, so
 * naming these here keeps this package browser-bundleable and keeps the
 * kernel → jj dependency acyclic.
 *
 * @category models
 */
export type JjFailure = JjError | Permission.PermissionError

/** @category services */
export interface Jj {
  /** Commits the working copy and returns the change id to restore to later. */
  readonly snapshot: (message?: string) => Effect.Effect<{ readonly changeId: ChangeId }, JjFailure>
  /** Puts the working copy back to `changeId`. */
  readonly restore: (changeId: ChangeId) => Effect.Effect<void, JjFailure>
  /** Unified diff between two revisions. */
  readonly diff: (from: ChangeId, to: ChangeId) => Effect.Effect<string, JjFailure>
  /**
   * Adds a named workspace rooted at `path` — one lane per parallel agent.
   *
   * `PlatformError` is in the channel because the guarded implementation
   * canonicalizes `path` against the workspace root before it asks for the
   * `jj:workspace-add` and `fs:write` capabilities, and resolving a path is a
   * filesystem operation that can itself fail.
   */
  readonly workspaceAdd: (name: string, path: string) => Effect.Effect<void, JjFailure | PlatformError>
  readonly workspaceForget: (name: string) => Effect.Effect<void, JjFailure>
  readonly status: () => Effect.Effect<string, JjFailure>
}

/**
 * @category services
 * @since 0.1.0
 */
export const Jj: Context.Service<Jj, Jj> = Context.Service("@smthrs/jj/Jj")

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
