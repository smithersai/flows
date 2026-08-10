/**
 * @since 0.1.0
 *
 * The `Jj` service: version control as a Host capability.
 *
 * `flows` snapshots the working copy around every step, so jj is not a tool the
 * agent happens to call — it is host access, and it goes through a layer like
 * every other. Contract only; module shape follows `effect/FileSystem`.
 *
 * The error lives here rather than in a shared host error module so that this
 * package depends on nothing but `effect`: a consumer that only snapshots a
 * working copy does not pull in a shell, a pty, or an HTTP transport.
 *
 * The tag key and the error `_tag` are `flows/host/…` and are FROZEN. They are
 * durable identity — step keys digest the resolved service set, and `JjError`
 * round-trips through the journal — so moving the module between packages must
 * not rename them.
 */
import { Context, Effect, Layer, Schema } from "effect"

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
export class JjError extends Schema.TaggedErrorClass<JjError>()("flows/host/JjError", {
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
