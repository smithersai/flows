/**
 * Functional workspace transactions for activity execution.
 *
 * An activity body normally mutates the host tree in place, which leaves the
 * engine two bad options: trust the declaration, or diff the whole repository
 * after the fact. This module takes the third one. The body runs against an
 * **isolated workspace** seeded with exactly its declared read set; its writes
 * are a value — a whole-tree diff — that reaches the host only through an
 * explicit, all-or-nothing {@link Service.materialize} step.
 *
 * Two consequences follow, and they are the reason this exists:
 *
 * - **Whole-tree write observation is structural.** The transaction *is* the
 *   tree, so "did this body write outside its declared write set" is a map
 *   comparison, not an inference. `StepBoundary`'s filesystem layer can only
 *   re-measure paths it was told about, which is why it never claims
 *   `wholeTreeWritesVerified` and why nothing it settled could enter the
 *   cross-run cache.
 * - **The host is untouched until copy-back.** An execution whose observations
 *   contradict its declaration is {@link Invalidated}, and an invalidated
 *   result exposes provenance and violations *only* — never the candidate
 *   output, files, or queued effects.
 *
 * This is a **deterministic transaction model, not a security boundary** — the
 * same caveat the proof of concept carried. A body that reaches the host
 * through a service this module does not seed (a spawned native process, an
 * undecorated socket) is outside the transaction. Actually denying that
 * ambient access is the VM/`SandboxProvider` provisioning story in
 * `docs/specs/Concepts/Agent Adapters.md`, and it is future work.
 *
 * Governing designs: `docs/specs/Concepts/Diff Review.md` (sandbox writes reach
 * the host only via copy-back of a selected, content-addressed, journaled
 * bundle), `docs/specs/Concepts/Effect Taxonomy.md` (the sandboxed-versus-bare
 * enforcement tiers), and `docs/specs/Concepts/Trust Granularity.md`.
 *
 * @since 0.1.0
 */
import * as ArtifactStore from "@smthrs/artifacts-next/ArtifactStore"
import { Sha256 } from "@smthrs/crypto-next"
import type { FileBoundary } from "@smthrs/flow-next/FileBoundary"
import { Workspace as KernelWorkspace } from "@smthrs/kernel-next/Workspace"
import * as Context from "effect/Context"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as PlatformError from "effect/PlatformError"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

/**
 * A protocol-neutral resource named in execution provenance.
 *
 * `kind` leaves room for later database, object-store, or network resources;
 * this implementation records filesystem resources with `kind: "file"`.
 *
 * @category models
 * @since 0.1.0
 */
export interface Resource {
  readonly kind: string
  readonly id: string
}

/**
 * An input value actually consulted by an execution.
 *
 * @category models
 * @since 0.1.0
 */
export interface InputObservation {
  readonly resource: Resource
  readonly digest: string
}

/**
 * An output value actually produced by an execution.
 *
 * @category models
 * @since 0.1.0
 */
export interface OutputObservation {
  readonly resource: Resource
  readonly operation: "write" | "remove"
  readonly digest: string | undefined
}

/**
 * Observed data dependencies and products of one isolated execution.
 *
 * @category models
 * @since 0.1.0
 */
export interface Provenance {
  readonly baseRevision: string
  readonly inputs: ReadonlyArray<InputObservation>
  readonly outputs: ReadonlyArray<OutputObservation>
}

/**
 * One functional filesystem transformation.
 *
 * `beforeDigest` is a materialization precondition, never a hint: copy-back is
 * a compare-and-set against it. `afterDigest` is absent for a removal;
 * otherwise it addresses the file's complete post-state. `after` carries those
 * bytes inline when they fit the host's inline bound, and is absent when they
 * were spilled to the content-addressed artifact store under `afterDigest`.
 *
 * @category models
 * @since 0.1.0
 */
export interface FileChange {
  readonly path: string
  readonly beforeDigest: string | undefined
  readonly afterDigest: string | undefined
  readonly after?: Uint8Array | undefined
}

/**
 * An external effect requested by an execution but deliberately **not**
 * dispatched inside its speculative transaction.
 *
 * A sandbox that dispatched these would have already sent the message when its
 * result turned out to be invalid, or would send it twice on a conflict retry.
 * Delivery and idempotency belong to a dispatch stage that runs after
 * copy-back settles; materializing file changes dispatches nothing.
 *
 * @category models
 * @since 0.1.0
 */
export interface QueuedEffect {
  readonly protocol: string
  readonly idempotencyKey: string
  readonly payload: unknown
}

/**
 * The generic functional result of one isolated execution.
 *
 * `output` is the body's ordinary return value and stays schema-typed — the
 * engine persists it as the activity's recorded result, so it must be
 * JSON-encodable. It is deliberately not bytes: file products travel in
 * {@link FileChange}, which is content-addressed and can spill to the artifact
 * store, and folding them into the output would defeat both.
 *
 * @category models
 * @since 0.1.0
 */
export interface WorkflowResult<out Output = unknown> {
  readonly output: Output
  readonly files: ReadonlyArray<FileChange>
  readonly provenance: Provenance
  readonly effects: ReadonlyArray<QueuedEffect>
}

/**
 * A filesystem and effect-outbox view scoped to one workspace transaction.
 *
 * A body receives this service only while executing inside
 * {@link Service.execute}; every call mutates the isolated transaction and
 * never the host. It sits beside — and over the same transaction as — the
 * re-rooted Effect `FileSystem` the sandbox also seeds, so a body written
 * against either surface is isolated.
 *
 * @category services
 * @since 0.1.0
 */
export interface Workspace {
  readonly readFile: (path: string) => Effect.Effect<Uint8Array, WorkspaceError>
  readonly writeFile: (path: string, content: Uint8Array) => Effect.Effect<void, WorkspaceError>
  readonly removeFile: (path: string) => Effect.Effect<void, WorkspaceError>
  readonly queueEffect: (effect: QueuedEffect) => Effect.Effect<void>
}

/**
 * Context service made available only inside a workspace transaction.
 *
 * @category services
 * @since 0.1.0
 */
export const Workspace: Context.Service<Workspace, Workspace> = Context.Service<Workspace>(
  "flows/engine-store/WorkspaceSandbox/Workspace"
)

/**
 * The declaration and body submitted to a workspace sandbox.
 *
 * `descriptor` is the same {@link FileBoundary} the step key was derived from
 * and `StepBoundary` prepares against — an optimistic prediction the sandbox
 * validates against what the body actually did. The proof of concept carried
 * `Effects.Declaration` plus `KeyMaterial` here; on this side the declaration
 * vocabulary is `FileBoundary` and step identity is already the engine's, so
 * `cacheKey` is only an opaque memo address the caller may omit.
 *
 * @category models
 * @since 0.1.0
 */
export interface Execution<out Output, out Error> {
  readonly descriptor: FileBoundary
  readonly cacheKey?: string | undefined
  readonly workflow: Effect.Effect<Output, Error, Workspace | FileSystem.FileSystem>
}

/**
 * Why observed execution contradicted its declaration.
 *
 * @category models
 * @since 0.1.0
 */
export interface DeclarationViolation {
  readonly kind: "undeclared-read" | "undeclared-write"
  readonly resource: Resource
}

/**
 * Memo disposition of an execution.
 *
 * The memo is a **run-local accelerator**, not the cross-run cache: the engine
 * owns that through `CacheStore` and the step key. `disabled` is what a caller
 * that supplied no `cacheKey` gets, and is the engine's ordinary case.
 *
 * A `hit` hands back the same {@link WorkflowResult} the miss produced rather
 * than a copy of it — the proof of concept deep-cloned, but cloning the output
 * needs `structuredClone`, and this port's output is not constrained to
 * `Schema.Json`. The transaction itself is still isolated (its reads and writes
 * copy bytes in both directions); what a caller must not do is mutate a
 * returned result in place and then ask for it again.
 *
 * @category models
 * @since 0.1.0
 */
export type CacheDisposition =
  | { readonly status: "disabled" }
  | { readonly status: "miss"; readonly key: string }
  | { readonly status: "hit"; readonly key: string }

/**
 * An execution whose observations matched its declaration.
 *
 * Only this variant is accepted by {@link Service.materialize}, so invalidated
 * speculative changes cannot be applied by accident.
 *
 * @category models
 * @since 0.1.0
 */
export interface Accepted<out Output = unknown> {
  readonly _tag: "Accepted"
  readonly result: WorkflowResult<Output>
  readonly cache: CacheDisposition
  /**
   * Deviations the declaration did not predict. Empty in hard mode — that
   * execution is {@link Invalidated} instead — and, in expected mode, the
   * whole-tree evidence behind the deviation the engine journals.
   *
   * The proof of concept had no expected mode and so had no field here. It is
   * carried on the result rather than recomputed by the caller because only
   * the sandbox knows the root the declaration and the observations have to be
   * compared in.
   */
  readonly violations: ReadonlyArray<DeclarationViolation>
}

/**
 * An execution discarded because its observations contradicted its
 * declaration.
 *
 * The candidate output, file changes, and queued effects are intentionally
 * absent from this shape — there is no accessor that leaks them. Provenance
 * and violations remain so the engine can journal an honest reason and, in
 * expected mode, re-plan.
 *
 * @category models
 * @since 0.1.0
 */
export interface Invalidated {
  readonly _tag: "Invalidated"
  readonly provenance: Provenance
  readonly violations: ReadonlyArray<DeclarationViolation>
}

/**
 * The result of validating one speculative execution.
 *
 * @category models
 * @since 0.1.0
 */
export type ExecutionResult<Output = unknown> = Accepted<Output> | Invalidated

/**
 * Stable workspace sandbox failure codes.
 *
 * @category schemas
 * @since 0.1.0
 */
export const WorkspaceErrorCode = Schema.Literals([
  "invalid_path",
  "not_found",
  "host_unavailable"
])

/**
 * Stable workspace sandbox failure codes.
 *
 * @category models
 * @since 0.1.0
 */
export type WorkspaceErrorCode = typeof WorkspaceErrorCode.Type

/**
 * A body could not execute inside — or its result could not be moved through —
 * an isolated workspace.
 *
 * @category errors
 * @since 0.1.0
 */
export class WorkspaceError extends Schema.TaggedErrorClass<WorkspaceError>()(
  "flows/engine-store/WorkspaceError",
  {
    code: WorkspaceErrorCode,
    message: Schema.String
  }
) {}

/**
 * Copy-back would overwrite host state that changed since the transaction's
 * base snapshot was taken.
 *
 * The engine answers this by retrying the attempt from a fresh base a bounded
 * number of times — rebase-shaped. The wider strategy surface (delay, rebase
 * versus stop, merge) is `docs/specs/Concepts/Worktree Lanes.md`'s and is not
 * decided here; this error is the seam it will attach to.
 *
 * @category errors
 * @since 0.1.0
 */
export class MaterializationConflict extends Schema.TaggedErrorClass<MaterializationConflict>()(
  "flows/engine-store/MaterializationConflict",
  {
    paths: Schema.Array(Schema.String),
    message: Schema.String
  }
) {}

/**
 * The two-phase workspace transaction service.
 *
 * `execute` is speculative and never touches the host. `materialize` is the
 * only host write, and it is all-or-nothing.
 *
 * @category models
 * @since 0.1.0
 */
export interface Service {
  readonly execute: <Output, Error>(
    execution: Execution<Output, Error>
  ) => Effect.Effect<ExecutionResult<Output>, Error | WorkspaceError, Crypto.Crypto>
  readonly materialize: <Output>(
    accepted: Accepted<Output>
  ) => Effect.Effect<void, MaterializationConflict | WorkspaceError, Crypto.Crypto>
}

/**
 * Context service for the selected workspace sandbox implementation.
 *
 * @category services
 * @since 0.1.0
 */
export const WorkspaceSandbox: Context.Service<Service, Service> = Context.Service<Service>(
  "flows/engine-store/WorkspaceSandbox"
)

/**
 * Constructs a workspace sandbox from an implementation.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (service: Service): Service => WorkspaceSandbox.of(service)

/**
 * Provides a workspace sandbox implementation.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (service: Service): Layer.Layer<Service> => Layer.succeed(WorkspaceSandbox, make(service))

/**
 * Delivery for the effects a transaction queued but refused to send.
 *
 * The engine runs this **after** copy-back settles, never inside the
 * transaction: an effect dispatched speculatively has already reached the
 * world when its execution turns out to be invalid, and has reached it twice
 * when copy-back loses a race and the body re-runs. Deduplication is by
 * {@link QueuedEffect.idempotencyKey}, which is the same key
 * `docs/specs/Concepts/Effect Taxonomy.md` requires before an irreversible
 * effect may be retried at all.
 *
 * @category services
 * @since 0.1.0
 */
export interface Dispatcher {
  readonly dispatch: (effect: QueuedEffect) => Effect.Effect<void>
}

/**
 * Context service for the queued-effect dispatch stage. Optional: with no
 * dispatcher provided the engine journals what a transaction queued and sends
 * nothing.
 *
 * @category services
 * @since 0.1.0
 */
export const EffectDispatcher: Context.Service<Dispatcher, Dispatcher> = Context.Service<Dispatcher>(
  "flows/engine-store/WorkspaceSandbox/EffectDispatcher"
)

/**
 * Provides a queued-effect dispatch stage.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerDispatcher = (dispatcher: Dispatcher): Layer.Layer<Dispatcher> =>
  Layer.succeed(EffectDispatcher, EffectDispatcher.of(dispatcher))

// -----------------------------------------------------------------------------
// path vocabulary
// -----------------------------------------------------------------------------

const decoder = new TextDecoder()
const encoder = new TextEncoder()

const invalidPath = (path: string): WorkspaceError =>
  new WorkspaceError({
    code: "invalid_path",
    message: `Workspace paths must be relative paths inside the workspace without '..': ${path}`
  })

/**
 * Normalizes a caller path to a workspace-relative key.
 *
 * Absolute paths are accepted only under `root`, which is how a body that
 * resolved `workspace.root` itself still lands inside the transaction; every
 * other absolute path, and anything traversing upward, is refused rather than
 * silently confined.
 */
const normalizePath = (root: string, path: string): Result.Result<string, WorkspaceError> => {
  const slashed = path.replaceAll("\\", "/")
  const rooted = root !== "" && slashed.startsWith(`${root}/`) ? slashed.slice(root.length + 1) : slashed
  const parts = rooted.split("/")
  if (rooted.startsWith("/") || parts.some((part) => part === "..")) return Result.fail(invalidPath(path))
  const compact = parts.filter((part) => part !== "" && part !== ".").join("/")
  return compact === "" ? Result.fail(invalidPath(path)) : Result.succeed(compact)
}

/**
 * Whether a declared write-set entry covers an observed path. Entries are
 * ordinarily literal paths (what `StepBoundary` captures); `*` and `**` are
 * honored so a declaration written as a glob per
 * `docs/specs/Concepts/Effect Taxonomy.md` still means what it says.
 */
const covers = (pattern: string, path: string): boolean => {
  if (pattern === path) return true
  if (!pattern.includes("*")) return false
  const source = pattern
    .replaceAll(/[.+?^${}()|[\]\\]/g, "\\$&")
    // The placeholder is NUL because a filesystem path cannot contain one:
    // any printable stand-in would be rewritten inside a pattern that
    // legitimately contained that character. It is written as an escape,
    // never as a literal control byte in the source.
    .replaceAll("**", "\u0000")
    .replaceAll("*", "[^/]*")
    .replaceAll("\u0000", ".*")
  return new RegExp(`^${source}$`).test(path)
}

const resource = (path: string): Resource => ({ kind: "file", id: path })

/**
 * Restates a declaration in the transaction's own path vocabulary.
 *
 * A caller may declare `out/result.txt` or the absolute path the same file has
 * on the host — the kernel-decorated `FileSystem` accepts both, so the
 * declaration does too. Observed paths are always workspace-relative, so the
 * declaration has to be brought to the same footing before anything is
 * compared against it, or an absolute declaration would cover nothing and
 * every write would read as undeclared. An entry that cannot be named inside
 * the workspace is kept verbatim: it covers nothing, which is the honest
 * answer for a declaration pointing outside the tree.
 */
const workspaceRelative = (root: string, descriptor: FileBoundary): FileBoundary => {
  const relative = (path: string): string => {
    const normalized = normalizePath(root, path)
    return Result.isFailure(normalized) ? path : normalized.success
  }
  return {
    readSet: descriptor.readSet.map((entry) => ({ ...entry, path: relative(entry.path) })),
    writeSet: descriptor.writeSet.map(relative),
    boundaryMode: descriptor.boundaryMode
  }
}

const digestOf = (bytes: Uint8Array): Effect.Effect<string, never, Crypto.Crypto> =>
  Schema.decodeUnknownEffect(Sha256)(bytes).pipe(Effect.orDie)

const parentDirectory = (path: string): string | undefined => {
  const index = path.lastIndexOf("/")
  return index <= 0 ? undefined : path.slice(0, index)
}

// -----------------------------------------------------------------------------
// the host seam
// -----------------------------------------------------------------------------

/**
 * Everything a workspace sandbox needs from the world it isolates bodies from.
 *
 * Splitting it out is what lets one transaction implementation serve both an
 * in-memory host (tests, browsers, and the conformance suite) and a real
 * filesystem host: the transaction, the diff, the violation check, and the
 * provenance are identical, and only *where the base comes from* and *where
 * copy-back lands* differ.
 *
 * @category models
 * @since 0.1.0
 */
export interface Host {
  /**
   * The transaction's base. A host that can seed exactly the declared read set
   * does so — a body then cannot read an undeclared file because it is not
   * there, which is the strong tier of `Effect Taxonomy.md`. A host that hands
   * back a wider tree gets the same guarantees post hoc, through the
   * undeclared-read check.
   */
  readonly snapshot: (
    descriptor: FileBoundary
  ) => Effect.Effect<ReadonlyMap<string, Uint8Array>, WorkspaceError, Crypto.Crypto>
  /**
   * The host's current digest for a path the transaction never observed, or
   * `undefined` when the host holds nothing there.
   *
   * A host that seeds only the declared read set does not know what else is on
   * disk, and "absent from the seed" is emphatically **not** "absent from the
   * host": a body writing a declared output it never declared as a read is the
   * ordinary case, and that file usually already exists from a previous run.
   * Treating the seed as the whole world made every such copy-back a
   * {@link MaterializationConflict} the engine could only rebase into the same
   * refusal, and made an identical rewrite look like a change.
   *
   * The digest this returns is therefore the change's `beforeDigest`. A blind
   * write cannot carry a compare-and-set over the body's whole execution — the
   * body never read the prior content, so there is nothing it could have
   * depended on — but copy-back still refuses if the path moves again between
   * the diff and the commit.
   */
  readonly baseline: (
    path: string
  ) => Effect.Effect<string | undefined, WorkspaceError, Crypto.Crypto>
  /**
   * Decides whether a produced file's bytes travel inline in its
   * {@link FileChange} or by content address. Returning `undefined` means the
   * bytes were retained under the change's `afterDigest` and must be fetched
   * back at copy-back.
   */
  readonly retain: (
    bytes: Uint8Array
  ) => Effect.Effect<Uint8Array | undefined, WorkspaceError, Crypto.Crypto>
  /**
   * Applies the diff to the host, all-or-nothing, as a compare-and-set on
   * every `beforeDigest`.
   */
  readonly commit: (
    changes: ReadonlyArray<FileChange>
  ) => Effect.Effect<void, MaterializationConflict | WorkspaceError, Crypto.Crypto>
  /** The absolute root absolute host paths are interpreted against. */
  readonly root: string
}

// -----------------------------------------------------------------------------
// the transaction
// -----------------------------------------------------------------------------

/**
 * Reads are recorded as bytes and hashed once, after the body returns.
 * Digesting inside `readFile` would put `Crypto` in the error-free signature
 * Effect's own `FileSystem` fixes, and a body must see the tag's real shape.
 */
interface Trace {
  readonly inputs: Array<{ readonly path: string; readonly content: Uint8Array }>
  readonly effects: Array<QueuedEffect>
}

const notFound = (path: string): WorkspaceError =>
  new WorkspaceError({ code: "not_found", message: `Workspace file does not exist: ${path}` })

/**
 * The transaction surfaces: the {@link Workspace} tag and a re-rooted Effect
 * `FileSystem`, both over one path-keyed map.
 *
 * The `FileSystem` is built from `makeNoop` on purpose. Only the operations
 * listed here are meaningful over a functional map, and a body reaching for
 * one that is not — a temp file, a watch, a stream — gets the platform's own
 * refusal rather than a plausible lie. Widening the surface is a ticket
 * (`.smithers/tickets/sandbox-filesystem-surface.md`), never a silent default.
 */
const transaction = (base: ReadonlyMap<string, Uint8Array>, trace: Trace, root: string) => {
  const files = new Map(base)
  const resolvePath = (path: string): Effect.Effect<string, WorkspaceError> => {
    const normalized = normalizePath(root, path)
    return Result.isFailure(normalized) ? Effect.fail(normalized.failure) : Effect.succeed(normalized.success)
  }
  const readBytes = Effect.fn("WorkspaceSandbox.read")(function*(path: string) {
    const key = yield* resolvePath(path)
    const content = files.get(key)
    if (content === undefined) return yield* Effect.fail(notFound(key))
    trace.inputs.push({ path: key, content })
    return content.slice()
  })
  const writeBytes = Effect.fn("WorkspaceSandbox.write")(function*(path: string, content: Uint8Array) {
    const key = yield* resolvePath(path)
    files.set(key, content.slice())
  })
  const removePath = Effect.fn("WorkspaceSandbox.remove")(function*(path: string) {
    const key = yield* resolvePath(path)
    files.delete(key)
  })
  const workspace = Workspace.of({
    readFile: (path) => readBytes(path),
    writeFile: (path, content) => writeBytes(path, content),
    removeFile: (path) => removePath(path),
    queueEffect: (effect) => Effect.sync(() => trace.effects.push(effect))
  })
  const refuse = (method: string, path: string) => (error: WorkspaceError) =>
    error.code === "not_found"
      ? PlatformError.systemError({
        _tag: "NotFound",
        module: "FileSystem",
        method,
        description: error.message,
        pathOrDescriptor: path
      })
      : PlatformError.badArgument({ module: "FileSystem", method, description: error.message })
  const fileSystem = FileSystem.makeNoop({
    exists: (path) =>
      resolvePath(path).pipe(
        Effect.map((key) => files.has(key)),
        // A path the transaction cannot even name does not exist in it; that
        // is an answer, not a host failure.
        Effect.catch(() => Effect.succeed(false))
      ),
    readFile: (path) => readBytes(path).pipe(Effect.mapError(refuse("readFile", path))),
    readFileString: (path) =>
      readBytes(path).pipe(
        Effect.map((bytes) => decoder.decode(bytes)),
        Effect.mapError(refuse("readFileString", path))
      ),
    writeFile: (path, data) => writeBytes(path, data).pipe(Effect.mapError(refuse("writeFile", path))),
    writeFileString: (path, data) =>
      writeBytes(path, encoder.encode(data)).pipe(Effect.mapError(refuse("writeFileString", path))),
    remove: (path) => removePath(path).pipe(Effect.mapError(refuse("remove", path))),
    // Directories are implicit in a path-keyed map: creating one is a
    // successful no-op so a body that mirrors ordinary filesystem discipline
    // works unchanged, and listing one is a prefix scan.
    makeDirectory: () => Effect.void,
    readDirectory: (path) =>
      resolvePath(path).pipe(
        Effect.map((key) => {
          const prefix = `${key}/`
          const entries = new Set<string>()
          for (const candidate of files.keys()) {
            if (!candidate.startsWith(prefix)) continue
            entries.add(candidate.slice(prefix.length).split("/")[0]!)
          }
          return [...entries].sort()
        }),
        Effect.mapError(refuse("readDirectory", path))
      )
  })
  return { files, workspace, fileSystem }
}

const changes = Effect.fn("WorkspaceSandbox.changes")(function*(
  base: ReadonlyMap<string, Uint8Array>,
  current: ReadonlyMap<string, Uint8Array>,
  host: Host
) {
  const paths = [...new Set([...base.keys(), ...current.keys()])].sort()
  const result: Array<FileChange> = []
  for (const path of paths) {
    const before = base.get(path)
    const after = current.get(path)
    // A path the transaction never observed is not a path the host lacks: ask
    // the host what is there before claiming the change creates it.
    const beforeDigest = before === undefined ? yield* host.baseline(path) : yield* digestOf(before)
    const afterDigest = after === undefined ? undefined : yield* digestOf(after)
    if (beforeDigest === afterDigest) continue
    result.push({
      path,
      beforeDigest,
      afterDigest,
      ...(after === undefined ? {} : { after: yield* host.retain(after) })
    })
  }
  return result
})

/**
 * The compare-and-set every copy-back runs before it writes a single byte.
 *
 * Both hosts share it, so "all-or-nothing" cannot drift between the in-memory
 * conformance implementation and the filesystem one: a bundle whose base moved
 * is refused whole, and the tree is left exactly as it was found.
 */
const conflicts = Effect.fn("WorkspaceSandbox.conflicts")(function*(
  changes: ReadonlyArray<FileChange>,
  current: (path: string) => Effect.Effect<Uint8Array | undefined, WorkspaceError, Crypto.Crypto>
) {
  const conflicting: Array<string> = []
  for (const change of changes) {
    const content = yield* current(change.path)
    const digest = content === undefined ? undefined : yield* digestOf(content)
    conflicting.push(...(digest === change.beforeDigest ? [] : [change.path]))
  }
  return conflicting.length === 0 ? undefined : new MaterializationConflict({
    paths: conflicting,
    message: "Workspace state changed after the transaction's base snapshot was taken"
  })
})

const revisionOf = Effect.fn("WorkspaceSandbox.revision")(function*(base: ReadonlyMap<string, Uint8Array>) {
  const entries: Array<{ readonly path: string; readonly digest: string }> = []
  for (const [path, content] of [...base].sort((left, right) => left[0].localeCompare(right[0]))) {
    entries.push({ path, digest: yield* digestOf(content) })
  }
  return yield* digestOf(encoder.encode(JSON.stringify(entries)))
})

/**
 * Everything the declaration failed to predict, deduplicated.
 *
 * Reads are checked against the declared read set's literal paths; writes
 * against the declared write set's patterns. A read of a file the body itself
 * produced is not undeclared — the transaction, not the host, supplied it.
 *
 * @category accessors
 * @since 0.1.0
 */
export const violations = (
  descriptor: FileBoundary,
  base: ReadonlyMap<string, Uint8Array>,
  provenance: Provenance
): ReadonlyArray<DeclarationViolation> => {
  const declaredReads = new Set(descriptor.readSet.map((entry) => entry.path))
  const observed: Array<DeclarationViolation> = [
    ...provenance.inputs
      .filter((input) => base.has(input.resource.id) && !declaredReads.has(input.resource.id))
      .map((input): DeclarationViolation => ({ kind: "undeclared-read", resource: input.resource })),
    ...provenance.outputs
      .filter((output) => !descriptor.writeSet.some((pattern) => covers(pattern, output.resource.id)))
      .map((output): DeclarationViolation => ({ kind: "undeclared-write", resource: output.resource }))
  ]
  return [
    ...new Map(observed.map((violation) => [`${violation.kind}:${violation.resource.id}`, violation])).values()
  ]
}

/**
 * Builds a workspace sandbox over a {@link Host}.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeHosted = (host: Host): Service => {
  const memo = new Map<
    string,
    { readonly result: WorkflowResult<never>; readonly violations: ReadonlyArray<DeclarationViolation> }
  >()
  return make({
    execute: Effect.fn("WorkspaceSandbox.execute")(function*<Output, Error>(
      execution: Execution<Output, Error>
    ) {
      const key = execution.cacheKey
      if (key !== undefined) {
        const hit = memo.get(key)
        if (hit !== undefined) {
          return {
            _tag: "Accepted" as const,
            result: hit.result as unknown as WorkflowResult<Output>,
            violations: hit.violations,
            cache: { status: "hit" as const, key }
          }
        }
      }
      const base = yield* host.snapshot(execution.descriptor)
      const trace: Trace = { inputs: [], effects: [] }
      const isolated = transaction(base, trace, host.root)
      const output = yield* execution.workflow.pipe(
        Effect.provideService(Workspace, isolated.workspace),
        Effect.provideService(FileSystem.FileSystem, isolated.fileSystem)
      )
      const files = yield* changes(base, isolated.files, host)
      const inputs: Array<InputObservation> = []
      for (const input of trace.inputs) {
        inputs.push({ resource: resource(input.path), digest: yield* digestOf(input.content) })
      }
      const provenance: Provenance = {
        baseRevision: yield* revisionOf(base),
        inputs,
        outputs: files.map((change) => ({
          resource: resource(change.path),
          operation: change.afterDigest === undefined ? "remove" as const : "write" as const,
          digest: change.afterDigest
        }))
      }
      const invalid = violations(workspaceRelative(host.root, execution.descriptor), base, provenance)
      // Hard mode discards; expected mode admits the result and leaves the
      // deviation for the engine to journal and reconcile
      // (`Effect Taxonomy.md`, "Expected sets — the soft mode"). Either way
      // the host has not been touched.
      if (invalid.length > 0 && execution.descriptor.boundaryMode === "hard") {
        return { _tag: "Invalidated" as const, provenance, violations: invalid }
      }
      const result: WorkflowResult<Output> = { output, files, provenance, effects: trace.effects }
      if (key !== undefined) {
        memo.set(key, { result: result as unknown as WorkflowResult<never>, violations: invalid })
      }
      return {
        _tag: "Accepted" as const,
        result,
        violations: invalid,
        cache: key === undefined ? { status: "disabled" as const } : { status: "miss" as const, key }
      }
    }),
    materialize: Effect.fn("WorkspaceSandbox.materialize")(function*(accepted) {
      yield* host.commit(accepted.result.files)
    })
  })
}

// -----------------------------------------------------------------------------
// the in-memory host
// -----------------------------------------------------------------------------

/**
 * Initial file contents accepted by {@link makeMemory}.
 *
 * @category models
 * @since 0.1.0
 */
export type InitialFiles = Readonly<Record<string, string | Uint8Array>>

/**
 * A host file snapshot exposed by the deterministic in-memory implementation.
 *
 * @category models
 * @since 0.1.0
 */
export interface HostFile {
  readonly path: string
  readonly content: Uint8Array
}

/**
 * The deterministic in-memory sandbox plus read-only test observations.
 *
 * @category models
 * @since 0.1.0
 */
export interface MemorySandbox {
  readonly service: Service
  readonly files: Effect.Effect<ReadonlyArray<HostFile>>
}

/**
 * Creates a deterministic in-memory workspace sandbox.
 *
 * The returned `files` effect observes *host* state, not a running
 * transaction: it changes only through `service.materialize`. This host hands
 * the transaction its whole tree rather than seeding the declared read set, so
 * an undeclared read is observable — which is exactly what makes it the
 * conformance implementation for the bare tier of `Effect Taxonomy.md`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeMemory = (
  initialFiles: InitialFiles = {}
): Effect.Effect<MemorySandbox, WorkspaceError, Crypto.Crypto> =>
  Effect.gen(function*() {
    const entries: Array<readonly [string, Uint8Array]> = []
    for (const [path, content] of Object.entries(initialFiles)) {
      const normalized = normalizePath("", path)
      if (Result.isFailure(normalized)) return yield* Effect.fail(normalized.failure)
      entries.push([normalized.success, typeof content === "string" ? encoder.encode(content) : content.slice()])
    }
    const host = yield* Ref.make<ReadonlyMap<string, Uint8Array>>(new Map(entries))
    const service = makeHosted({
      root: "",
      snapshot: () => Ref.get(host),
      // This host seeds the transaction with the WHOLE tree, so a path the
      // transaction did not observe is one the host genuinely did not hold:
      // `undefined` is the honest snapshot-time answer, and a file that
      // appeared underneath the transaction is caught by copy-back's
      // compare-and-set rather than clobbered.
      baseline: () => Effect.succeed(undefined),
      retain: (bytes) => Effect.succeed(bytes.slice()),
      commit: Effect.fn("WorkspaceSandbox.commit")(function*(changes) {
        const current = yield* Ref.get(host)
        const conflict = yield* conflicts(changes, (path) => Effect.succeed(current.get(path)))
        if (conflict !== undefined) return yield* Effect.fail(conflict)
        const next = new Map(current)
        for (const change of changes) {
          if (change.afterDigest === undefined) next.delete(change.path)
          else next.set(change.path, change.after!.slice())
        }
        yield* Ref.set(host, next)
      })
    })
    return {
      service,
      files: Ref.get(host).pipe(
        Effect.map((current) =>
          [...current]
            .map(([path, content]) => ({ path, content }))
            .sort((left, right) => left.path.localeCompare(right.path))
        )
      )
    }
  })

// -----------------------------------------------------------------------------
// the filesystem host
// -----------------------------------------------------------------------------

/**
 * Filesystem workspace sandbox options.
 *
 * @category models
 * @since 0.1.0
 */
export interface FileSystemOptions {
  /**
   * The largest produced file (in bytes) carried inline in its
   * {@link FileChange}. Anything larger is retained in the content-addressed
   * artifact store and fetched back at copy-back. Defaults to 1 MiB, matching
   * `StepBoundary`'s evidence bound.
   */
  readonly maxInlineBytes?: number | undefined
}

const defaultMaxInlineBytes = 1024 * 1024

const hostFailure = (cause: unknown): WorkspaceError =>
  new WorkspaceError({
    code: "host_unavailable",
    message: `the host filesystem could not serve the workspace transaction: ${String(cause)}`
  })

const artifactFailure = (cause: { readonly message: string }): WorkspaceError =>
  new WorkspaceError({
    code: "host_unavailable",
    message: `the artifact store could not serve the workspace transaction: ${cause.message}`
  })

/**
 * Builds the filesystem-backed workspace sandbox.
 *
 * **Copy-in, not overlay.** The transaction is seeded with exactly the
 * declared read set and nothing else, which is the sandboxed tier of
 * `docs/specs/Concepts/Effect Taxonomy.md:44-48` — Bazel's own strategy — and
 * the reason whole-tree write observation is structural here. Re-rooting a
 * body onto a bare host tree instead would leave every undeclared file
 * readable and reduce enforcement to the taxonomy's weakest, post-hoc
 * detection-by-diff tier; and the OS-level overlay that would fix that is not
 * reachable through Effect's `FileSystem` tag, so it could not run in a
 * browser. Seeding costs a copy of the declared reads and buys both.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeFileSystem = (
  fs: FileSystem.FileSystem,
  artifacts: ArtifactStore.Service,
  workspaceRoot: string,
  options: FileSystemOptions = {}
): Service => {
  const maxInlineBytes = options.maxInlineBytes ?? defaultMaxInlineBytes
  const root = workspaceRoot.replaceAll(/\/+$/g, "")
  const hostPath = (path: string) => root === "" ? path : `${root}/${path}`
  const readIfPresent = Effect.fn("WorkspaceSandbox.readIfPresent")(function*(path: string) {
    const present = yield* fs.exists(path).pipe(Effect.mapError(hostFailure))
    if (!present) return undefined
    return yield* fs.readFile(path).pipe(Effect.mapError(hostFailure))
  })
  return makeHosted({
    root,
    snapshot: Effect.fn("WorkspaceSandbox.snapshot")(function*(descriptor) {
      const base = new Map<string, Uint8Array>()
      for (const entry of descriptor.readSet) {
        const normalized = normalizePath(root, entry.path)
        if (Result.isFailure(normalized)) return yield* Effect.fail(normalized.failure)
        const content = yield* readIfPresent(hostPath(normalized.success))
        // A declared read that does not exist is seeded as absent, not as an
        // error: `StepBoundary.prepare` already records the mismatch as the
        // evidence that refuses the cache hit.
        if (content !== undefined) base.set(normalized.success, content)
      }
      return base
    }),
    baseline: Effect.fn("WorkspaceSandbox.baseline")(function*(path) {
      const content = yield* readIfPresent(hostPath(path))
      return content === undefined ? undefined : yield* digestOf(content)
    }),
    // The bytes now live at the change's `afterDigest`; the change itself
    // carries only the reference, exactly as oversized `StepBoundary`
    // evidence does.
    retain: (bytes) =>
      bytes.length <= maxInlineBytes
        ? Effect.succeed(bytes)
        : artifacts.put(bytes).pipe(Effect.mapError(artifactFailure), Effect.as(undefined)),
    commit: Effect.fn("WorkspaceSandbox.commit")(function*(changes) {
      // PRECONDITIONS FIRST, WRITES SECOND. Every `beforeDigest` is compared
      // against the live host before any byte lands, so a conflicting bundle
      // leaves the tree exactly as it found it and the engine's retry starts
      // from a clean base.
      const conflict = yield* conflicts(changes, (path) => readIfPresent(hostPath(path)))
      if (conflict !== undefined) return yield* Effect.fail(conflict)
      for (const change of changes) {
        const target = hostPath(change.path)
        if (change.afterDigest === undefined) {
          yield* fs.remove(target).pipe(Effect.mapError(hostFailure))
          continue
        }
        const parent = parentDirectory(target)
        if (parent !== undefined) {
          yield* fs.makeDirectory(parent, { recursive: true }).pipe(Effect.mapError(hostFailure))
        }
        const bytes = change.after ?? (yield* artifacts.get(`${change.afterDigest}`).pipe(
          Effect.mapError((error) =>
            error._tag === "@smthrs/artifacts-next/ArtifactStoreError"
              ? artifactFailure(error)
              : new WorkspaceError({
                code: "not_found",
                message: `the retained bytes for ${change.path} are unavailable: ${error.message}`
              })
          )
        ))
        yield* fs.writeFile(target, bytes).pipe(Effect.mapError(hostFailure))
      }
    })
  })
}

/**
 * Provides the filesystem-backed workspace sandbox.
 *
 * Host access arrives through Effect's `FileSystem` tag — the same tag the
 * capability kernel decorates in place — and blob retention through
 * `@smthrs/artifacts-next`, so the same sandbox runs over a purely local store or a
 * local-plus-shared composition without knowing which it got. The workspace
 * root arrives through the kernel's `Workspace` service, so absolute paths a
 * body resolved for itself still land inside the transaction.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerFileSystem = (
  options: FileSystemOptions = {}
): Layer.Layer<Service, never, FileSystem.FileSystem | ArtifactStore.ArtifactStore | KernelWorkspace> =>
  Layer.effect(
    WorkspaceSandbox,
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const artifacts = yield* ArtifactStore.ArtifactStore
      const workspace = yield* KernelWorkspace
      return makeFileSystem(fs, artifacts, workspace.root, options)
    })
  )
