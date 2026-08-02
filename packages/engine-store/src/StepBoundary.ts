/**
 * Hermetic step boundary contracts, the filesystem-backed production
 * implementation, and the deterministic test implementation.
 *
 * @since 0.1.0
 */
import { FileSystem } from "@smithers/kernel"
import { Digest } from "@smithers/keys"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

/** @since 0.1.0 @category models */
export const BoundaryMode = Schema.Literals(["hard", "expected"])

/** @since 0.1.0 @category models */
export type BoundaryMode = typeof BoundaryMode.Type

/** @since 0.1.0 @category models */
export const ReadSetEntry = Schema.Struct({
  path: Schema.String,
  digest: Schema.String
})

/** @since 0.1.0 @category models */
export type ReadSetEntry = typeof ReadSetEntry.Type

/** @since 0.1.0 @category models */
export const Descriptor = Schema.Struct({
  readSet: Schema.Array(ReadSetEntry),
  writeSet: Schema.Array(Schema.String),
  boundaryMode: BoundaryMode
})

/** @since 0.1.0 @category models */
export type Descriptor = typeof Descriptor.Type

/** @since 0.1.0 @category models */
export interface PreparedBoundary {
  readonly descriptor: Descriptor
  /**
   * What the host actually measured for the declared read set at prepare
   * time. The declared digests are caller metadata folded into the step key;
   * this is the evidence that they still describe reality, and a sealed
   * cache hit is refused when the two disagree (issue #90).
   */
  readonly readSnapshot: ReadonlyArray<ReadSetEntry>
}

/**
 * Whether every declared read still matches what the host measured.
 *
 * Reads the host reports but the declaration never claimed are ignored: the
 * declaration is the dependency edge set, and an incidental extra read is not
 * one of its edges. A declared path missing from the measurement counts as a
 * mismatch — its value is unknown, so reuse cannot be justified.
 *
 * @since 0.1.0
 * @category predicates
 */
export const readSetMatches = (prepared: PreparedBoundary): boolean =>
  prepared.descriptor.readSet.every((entry) =>
    prepared.readSnapshot.some((measured) => measured.path === entry.path && measured.digest === entry.digest)
  )

/** @since 0.1.0 @category models */
export const BoundaryDeviation = Schema.TaggedStruct("ExpectedSetDeviation", {
  paths: Schema.Array(Schema.String),
  diffIdentity: Schema.NonEmptyString
})

/** @since 0.1.0 @category models */
export type BoundaryDeviation = typeof BoundaryDeviation.Type

/** @since 0.1.0 @category models */
export const BoundaryEvidence = Schema.Struct({
  declaredOutputs: Schema.Unknown,
  diffIdentity: Schema.NonEmptyString,
  deviation: Schema.optional(BoundaryDeviation)
})

/** @since 0.1.0 @category models */
export type BoundaryEvidence = typeof BoundaryEvidence.Type

/** @since 0.1.0 @category errors */
export class UndeclaredWrite extends Schema.TaggedErrorClass<UndeclaredWrite>()(
  "flows/engine-store/UndeclaredWrite",
  {
    code: Schema.Literal("undeclared_write"),
    paths: Schema.Array(Schema.String),
    diffIdentity: Schema.NonEmptyString
  }
) {}

/** @since 0.1.0 @category errors */
export class UnsupportedBoundary extends Schema.TaggedErrorClass<UnsupportedBoundary>()(
  "flows/engine-store/UnsupportedBoundary",
  {
    code: Schema.Literal("unsupported_boundary"),
    message: Schema.String
  }
) {}

/** @since 0.1.0 @category models */
export interface Service {
  readonly prepare: (descriptor: Descriptor) => Effect.Effect<PreparedBoundary, UnsupportedBoundary>
  readonly settle: (
    prepared: PreparedBoundary
  ) => Effect.Effect<BoundaryEvidence, UndeclaredWrite | UnsupportedBoundary>
  readonly replayOutputs: (evidence: BoundaryEvidence) => Effect.Effect<void, UnsupportedBoundary>
}

/** @since 0.1.0 @category services */
export const StepBoundary: Context.Service<Service, Service> = Context.Service<Service>(
  "flows/engine-store/StepBoundary"
)

/** @since 0.1.0 @category constructors */
export const make = (service: Service): Service => StepBoundary.of(service)

/**
 * The digest a measurement reports for a declared path that does not exist.
 * Declared digests are hex SHA-256 strings, so the sentinel can never
 * collide with a real measurement — a declaration naming a vanished file
 * always mismatches and the cache hit is refused.
 */
const absentDigest = "absent"

/**
 * The persisted shape of the production layer's `declaredOutputs`: the
 * declared write set's materialized post-state, so a cache-hit replay can
 * reproduce the outputs on a workspace that never ran the step.
 *
 * Outputs are recorded by content digest, never inlined unbounded
 * (issue #113): a `null` digest records that the path did not exist at
 * settle time; `content` (base64) is present only when the payload fits the
 * configured inline bound, otherwise the bytes live in the host's
 * content-addressed object directory under the digest and the row carries
 * only the reference. Temporal's blob-size limits are the prior art — the
 * evidence is persisted into every attempt row and cache entry.
 */
const MaterializedOutputs = Schema.Struct({
  outputs: Schema.Array(Schema.Struct({
    path: Schema.String,
    digest: Schema.NullOr(Schema.String),
    sizeBytes: Schema.optional(Schema.Number),
    content: Schema.optional(Schema.String)
  }))
})

/**
 * The directory portion of a slash-separated path, or `undefined` for a
 * bare filename (nothing to create). Boundary paths are workspace-relative
 * and slash-separated — the same normalization the kernel `FileSystem`
 * layer applies.
 */
const parentDirectory = (path: string): string | undefined => {
  const index = path.lastIndexOf("/")
  return index <= 0 ? undefined : path.slice(0, index)
}

const hostFailure = (cause: unknown): UnsupportedBoundary =>
  new UnsupportedBoundary({
    code: "unsupported_boundary",
    message: `the host filesystem could not enforce the step boundary: ${String(cause)}`
  })

/** @since 0.1.0 @category models */
export interface FileSystemOptions {
  /**
   * Where blob-referenced outputs are stored, content-addressed by digest.
   * Workspace-relative; defaults to `.flows/objects`.
   */
  readonly objectsDirectory?: string | undefined
  /**
   * The largest output (in bytes) inlined into the boundary evidence
   * itself. Anything larger is written to {@link objectsDirectory} and
   * recorded by digest reference only (issue #113). Defaults to 1 MiB.
   */
  readonly maxInlineBytes?: number | undefined
}

const defaultObjectsDirectory = ".flows/objects"
const defaultMaxInlineBytes = 1024 * 1024

type MaterializedOutput = typeof MaterializedOutputs.Type["outputs"][number]

/**
 * Builds the filesystem-backed boundary service.
 *
 * @since 0.1.0
 * @category constructors
 */
export const makeFileSystem = (fs: FileSystem.FileSystem, options: FileSystemOptions = {}): Service => {
  const objectsDirectory = options.objectsDirectory ?? defaultObjectsDirectory
  const maxInlineBytes = options.maxInlineBytes ?? defaultMaxInlineBytes
  /**
   * Distinguishes concurrent temp paths for the same digest within this
   * service instance. No wall clock or randomness is needed: the digest
   * already namespaces the content, and the counter separates in-flight
   * writers of this process (issue #117).
   */
  let tempSequence = 0
  const measure = (path: string): Effect.Effect<string, UnsupportedBoundary> =>
    fs.exists(path).pipe(
      Effect.flatMap((present) =>
        present
          ? Effect.map(fs.readFile(path), (bytes) => Digest.digest(bytes))
          : Effect.succeed(absentDigest)
      ),
      Effect.mapError(hostFailure)
    )
  const capture = Effect.fn("StepBoundary.capture")(function*(path: string) {
    const present = yield* fs.exists(path).pipe(Effect.mapError(hostFailure))
    if (!present) return { path, digest: null } satisfies MaterializedOutput
    const bytes = yield* fs.readFile(path).pipe(Effect.mapError(hostFailure))
    const digest = Digest.digest(bytes)
    if (bytes.length <= maxInlineBytes) {
      return {
        path,
        digest,
        sizeBytes: bytes.length,
        content: Encoding.encodeBase64(bytes)
      } satisfies MaterializedOutput
    }
    // Over the inline bound: the payload goes to the content-addressed
    // object directory and the persisted row carries only the reference.
    const blobPath = `${objectsDirectory}/${digest}`
    const stored = yield* fs.exists(blobPath).pipe(Effect.mapError(hostFailure))
    if (!stored) {
      // Atomic publication (issue #117): a plain write to the canonical
      // address could be observed — or survive a crash — as a partial file
      // that every later materialization of this digest would trust. The
      // payload lands at a temp path and is renamed into place; an existing
      // blob is content-addressed and never rewritten.
      yield* fs.makeDirectory(objectsDirectory, { recursive: true }).pipe(Effect.mapError(hostFailure))
      const tempPath = `${blobPath}.tmp-${tempSequence++}`
      yield* fs.writeFile(tempPath, bytes).pipe(Effect.mapError(hostFailure))
      yield* fs.rename(tempPath, blobPath).pipe(Effect.mapError(hostFailure))
    }
    return { path, digest, sizeBytes: bytes.length } satisfies MaterializedOutput
  })
  const materialize = Effect.fn("StepBoundary.materialize")(function*(output: MaterializedOutput) {
    let bytes: Uint8Array
    if (output.content !== undefined) {
      const decoded = Encoding.decodeBase64(output.content)
      if (Result.isFailure(decoded)) {
        return yield* Effect.fail(hostFailure(decoded.failure))
      }
      bytes = decoded.success
    } else {
      const blobPath = `${objectsDirectory}/${output.digest}`
      const present = yield* fs.exists(blobPath).pipe(Effect.mapError(hostFailure))
      if (!present) {
        // The reference cannot be resolved on this host — refusing routes
        // the issue-#107 call sites to a real execution instead of
        // materializing nothing silently.
        return yield* Effect.fail(
          new UnsupportedBoundary({
            code: "unsupported_boundary",
            message: `the referenced output blob ${output.digest} is not in ${objectsDirectory}`
          })
        )
      }
      bytes = yield* fs.readFile(blobPath).pipe(Effect.mapError(hostFailure))
    }
    // Every materialization is digest-verified (issue #117): a corrupted or
    // truncated blob at the canonical address — or tampered inline content —
    // must never be written into the workspace as if it were the recorded
    // output.
    const measured = Digest.digest(bytes)
    if (measured !== output.digest) {
      return yield* Effect.fail(
        new UnsupportedBoundary({
          code: "unsupported_boundary",
          message: `digest mismatch materializing ${output.path}: recorded ${output.digest}, measured ${measured}`
        })
      )
    }
    // The original body may have created the output's directory itself; a
    // fresh workspace replaying the evidence has no such directory and
    // `writeFile` does not create parents (issue #107).
    const parent = parentDirectory(output.path)
    if (parent !== undefined) {
      yield* fs.makeDirectory(parent, { recursive: true }).pipe(Effect.mapError(hostFailure))
    }
    yield* fs.writeFile(output.path, bytes).pipe(Effect.mapError(hostFailure))
  })
  return make({
    prepare: Effect.fn("StepBoundary.prepare")(function*(descriptor) {
      // The dirty check's evidence (issue #90): what the host actually
      // measured for every declared read, never the declaration itself —
      // defaulting the snapshot to the declaration made `readSetMatches`
      // compare the declaration against itself and pass unconditionally
      // (issue #104).
      const readSnapshot: Array<ReadSetEntry> = []
      for (const entry of descriptor.readSet) {
        readSnapshot.push({ path: entry.path, digest: yield* measure(entry.path) })
      }
      return { descriptor, readSnapshot }
    }),
    settle: Effect.fn("StepBoundary.settle")(function*(prepared) {
      // Undeclared-write detection is scoped to the declared read set: a
      // declared read whose content moved during the body and is not also a
      // declared write was mutated outside the contract. Whole-tree change
      // detection needs the jj diff surface and stays a documented
      // limitation of this layer rather than a silent pass — the read set
      // is exactly the material cacheability rests on.
      const declaredWrites = new Set(prepared.descriptor.writeSet)
      const undeclared: Array<string> = []
      for (const entry of prepared.readSnapshot) {
        if (declaredWrites.has(entry.path)) continue
        if ((yield* measure(entry.path)) !== entry.digest) undeclared.push(entry.path)
      }
      const outputs: Array<MaterializedOutput> = []
      for (const path of prepared.descriptor.writeSet) {
        outputs.push(yield* capture(path))
      }
      const diffIdentity = Digest.digest(JSON.stringify(
        outputs.map((output) => [output.path, output.digest])
      ))
      if (undeclared.length > 0 && prepared.descriptor.boundaryMode === "hard") {
        return yield* Effect.fail(
          new UndeclaredWrite({ code: "undeclared_write", paths: undeclared, diffIdentity })
        )
      }
      return {
        declaredOutputs: { outputs },
        diffIdentity,
        ...(undeclared.length === 0
          ? {}
          : { deviation: { _tag: "ExpectedSetDeviation" as const, paths: undeclared, diffIdentity } })
      }
    }),
    replayOutputs: Effect.fn("StepBoundary.replayOutputs")(function*(evidence) {
      const decoded = Schema.decodeUnknownResult(MaterializedOutputs)(evidence.declaredOutputs)
      if (decoded._tag === "Failure") {
        // Evidence recorded by a different boundary implementation carries
        // no materializable outputs; refusing is honest — the caller's
        // dispatch path falls back to a real execution or fails visibly.
        return yield* Effect.fail(
          new UnsupportedBoundary({
            code: "unsupported_boundary",
            message: "the recorded boundary evidence carries no materializable outputs"
          })
        )
      }
      for (const output of decoded.success.outputs) {
        if (output.digest === null) {
          const present = yield* fs.exists(output.path).pipe(Effect.mapError(hostFailure))
          if (present) yield* fs.remove(output.path).pipe(Effect.mapError(hostFailure))
        } else {
          yield* materialize(output)
        }
      }
    })
  })
}

/**
 * Provides the filesystem-backed production boundary: `prepare` measures the
 * declared read set for real, `settle` detects reads mutated outside the
 * declared write set and captures the write set's post-state, and
 * `replayOutputs` re-materializes those outputs on cache-hit replay.
 *
 * Host access arrives through the kernel `FileSystem` layer — the same seam
 * every host implementation (node, bun, browser, sandbox) already provides.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer: Layer.Layer<Service, never, FileSystem.FileSystem> = Layer.effect(
  StepBoundary,
  Effect.map(FileSystem.FileSystem, makeFileSystem)
)

/** @since 0.1.0 @category models */
export interface TestOptions {
  readonly changedPaths?: ReadonlyArray<string> | undefined
  /**
   * What `prepare` reports as measured for the declared read set. Defaults
   * to the declaration itself; a test supplies a different snapshot to stand
   * for a file whose content moved out from under a stale declaration
   * (issue #90).
   */
  readonly readSnapshot?: ReadonlyArray<ReadSetEntry> | undefined
  readonly declaredOutputs?: unknown
  readonly diffIdentity?: string | undefined
  readonly supported?: boolean | undefined
  readonly onReplay?: (evidence: BoundaryEvidence) => void
}

const unsupported = (): UnsupportedBoundary =>
  new UnsupportedBoundary({
    code: "unsupported_boundary",
    message: "the host cannot enforce the declared step boundary"
  })

/**
 * Deterministic in-memory boundary suitable only for tests. Production
 * wiring uses {@link layer}, the filesystem-backed implementation.
 *
 * TODO(piece-6): whole-tree change detection (writes outside the declared
 * read and write sets) needs structured changed-path reporting from the jj
 * surface or sandbox bind mounts; {@link layer} detects mutations within
 * the declared read set only.
 *
 * @since 0.1.0
 * @category layers
 */
export const layerTest = (options: TestOptions = {}): Layer.Layer<Service> => {
  const changedPaths = options.changedPaths ?? []
  const diffIdentity = options.diffIdentity ?? "test-diff"
  const service = make({
    prepare: Effect.fn("StepBoundary.prepare")(function*(descriptor) {
      if (options.supported === false) return yield* Effect.fail(unsupported())
      return { descriptor, readSnapshot: options.readSnapshot ?? descriptor.readSet }
    }),
    settle: Effect.fn("StepBoundary.settle")(function*(prepared) {
      if (options.supported === false) return yield* Effect.fail(unsupported())
      const undeclared = changedPaths.filter((path) => !prepared.descriptor.writeSet.includes(path))
      if (undeclared.length > 0 && prepared.descriptor.boundaryMode === "hard") {
        return yield* Effect.fail(new UndeclaredWrite({ code: "undeclared_write", paths: undeclared, diffIdentity }))
      }
      return {
        declaredOutputs: options.declaredOutputs ?? { paths: prepared.descriptor.writeSet },
        diffIdentity,
        ...(undeclared.length === 0
          ? {}
          : { deviation: { _tag: "ExpectedSetDeviation" as const, paths: undeclared, diffIdentity } })
      }
    }),
    replayOutputs: Effect.fn("StepBoundary.replayOutputs")(function*(evidence) {
      if (options.supported === false) return yield* Effect.fail(unsupported())
      yield* Effect.sync(() => {
        options.onReplay?.(evidence)
      })
    })
  })
  return Layer.succeed(StepBoundary, service)
}
