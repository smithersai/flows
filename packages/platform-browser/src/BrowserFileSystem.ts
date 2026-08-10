/**
 * Browser implementation of Effect's `FileSystem` service.
 *
 * A browser tab has no `node:fs`. What it has is a virtual filesystem mounted
 * over IndexedDB, OPFS, or memory — in practice **ZenFS** — which exposes a
 * `node:fs/promises`-shaped object. This module adapts that object into a
 * `FileSystem` layer, the way `NodeFileSystem` adapts `node:fs`.
 *
 * Unlike `NodeFileSystem`, the layer is a **function**: the page owns which
 * backend is mounted and when, so the promises object is an argument rather
 * than a static import. That also keeps `@zenfs/core` out of this package's
 * dependency list — {@link ZenFsPromisesLike} is a structural slice, and Node's
 * own `node:fs/promises` satisfies it, which is what the tests use.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as PlatformError from "effect/PlatformError"
import * as Stream from "effect/Stream"

/**
 * The slice of a ZenFS promises API this module depends on.
 *
 * Satisfied by the **`@zenfs/core`** npm package's `fs.promises` export (and by
 * Node's own `node:fs/promises`, which is what the test suite hands it). We
 * take the object rather than importing the package so the browser bundle
 * decides which backend is mounted (IndexedDB, OPFS, in-memory) before handing
 * it to us.
 *
 * @category models
 * @since 0.1.0
 */
export interface ZenFsPromisesLike {
  readonly open: (path: string, flags: "r") => Promise<ZenFsFileHandleLike>
  readonly readFile: (path: string) => Promise<Uint8Array>
  readonly writeFile: (
    path: string,
    data: Uint8Array,
    options?: { readonly flag?: string; readonly mode?: number }
  ) => Promise<void>
  readonly mkdir: (path: string, options?: { readonly recursive?: boolean }) => Promise<unknown>
  readonly readdir: (path: string) => Promise<Array<string>>
  readonly stat: (path: string) => Promise<ZenFsStatsLike>
  readonly rm: (
    path: string,
    options?: { readonly recursive?: boolean; readonly force?: boolean }
  ) => Promise<void>
}

/**
 * The bounded-read slice shared by ZenFS and Node file handles.
 *
 * @category models
 * @since 0.1.0
 */
export interface ZenFsFileHandleLike {
  readonly read: (
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number
  ) => Promise<{ readonly bytesRead: number }>
  readonly close: () => Promise<void>
}

/**
 * The subset of a ZenFS/Node `Stats` object `stat` needs.
 *
 * @category models
 * @since 0.1.0
 */
export interface ZenFsStatsLike {
  readonly size: number
  readonly mode: number
  readonly mtimeMs: number
  readonly isFile: () => boolean
  readonly isDirectory: () => boolean
  readonly isSymbolicLink: () => boolean
}

/**
 * Map a thrown ZenFS/Node error onto a `PlatformError`, mirroring how effect's
 * own platform implementations construct one: a normalized `_tag`, the module
 * and method that failed, and the path. `ENOENT` is the only code worth
 * special-casing — `exists` and every `catchTag` in effect's `make` branch on
 * `NotFound`.
 */
const platformError = (method: string, path: string) => (cause: unknown): PlatformError.PlatformError =>
  PlatformError.systemError({
    _tag: hasCode(cause, "ENOENT") ? "NotFound" : hasCode(cause, "EEXIST") ? "AlreadyExists" : "Unknown",
    module: "FileSystem",
    method,
    pathOrDescriptor: path,
    description: cause instanceof Error ? cause.message : String(cause),
    cause
  })

const hasCode = (cause: unknown, code: string): boolean =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === code

const fileType = (stats: ZenFsStatsLike): FileSystem.File.Type =>
  stats.isFile() ? "File" : stats.isDirectory() ? "Directory" : stats.isSymbolicLink() ? "SymbolicLink" : "Unknown"

const fileInfo = (stats: ZenFsStatsLike): FileSystem.File.Info => ({
  type: fileType(stats),
  mtime: Option.some(new Date(stats.mtimeMs)),
  atime: Option.none(),
  birthtime: Option.none(),
  dev: 0,
  ino: Option.none(),
  mode: stats.mode,
  nlink: Option.none(),
  uid: Option.none(),
  gid: Option.none(),
  rdev: Option.none(),
  size: FileSystem.Size(stats.size),
  blksize: Option.none(),
  blocks: Option.none()
})

const readBytes = (fs: ZenFsPromisesLike, path: string): Effect.Effect<Uint8Array, PlatformError.PlatformError> =>
  Effect.tryPromise({ try: () => fs.readFile(path), catch: platformError("readFile", path) })

/**
 * `flag` is forwarded rather than dropped: both ZenFS and `node:fs/promises`
 * honour it, and silently turning an `"a"` into a truncating write would lose
 * the caller's data. `"wx"` surfaces as `EEXIST`, which {@link platformError}
 * already normalizes to `AlreadyExists`.
 */
const writeBytes = (
  fs: ZenFsPromisesLike,
  path: string,
  data: Uint8Array,
  options?: { readonly flag?: string | undefined; readonly mode?: number | undefined }
): Effect.Effect<void, PlatformError.PlatformError> =>
  Effect.tryPromise({
    try: () =>
      fs.writeFile(path, data, {
        ...(options?.flag === undefined ? {} : { flag: options.flag }),
        ...(options?.mode === undefined ? {} : { mode: options.mode })
      }),
    catch: platformError("writeFile", path)
  })

const streamFile = (
  fs: ZenFsPromisesLike,
  path: string,
  options?: {
    readonly bytesToRead?: FileSystem.SizeInput | undefined
    readonly chunkSize?: FileSystem.SizeInput | undefined
    readonly offset?: FileSystem.SizeInput | undefined
  }
): Stream.Stream<Uint8Array, PlatformError.PlatformError> =>
  Stream.unwrap(
    Effect.map(
      Effect.acquireRelease(
        Effect.tryPromise({
          try: () => fs.open(path, "r"),
          catch: platformError("stream", path)
        }),
        (handle) =>
          Effect.orDie(
            Effect.tryPromise({
              try: () => handle.close(),
              catch: platformError("stream.close", path)
            })
          )
      ),
      (handle) => {
        const start = Math.max(0, Number(options?.offset ?? 0))
        const bytesToRead = options?.bytesToRead === undefined
          ? Number.POSITIVE_INFINITY
          : Math.max(0, Number(options.bytesToRead))
        const chunkSize = Math.max(1, Number(options?.chunkSize ?? 64 * 1024))
        return Stream.unfold(
          { position: start, remaining: bytesToRead },
          ({ position, remaining }) => {
            if (remaining === 0) return Effect.succeed(undefined)
            const size = Math.min(chunkSize, remaining)
            const buffer = new Uint8Array(size)
            return Effect.tryPromise({
              try: () => handle.read(buffer, 0, size, position),
              catch: platformError("stream.read", path)
            }).pipe(
              Effect.map(({ bytesRead }) =>
                bytesRead === 0
                  ? undefined
                  : [
                    bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead),
                    {
                      position: position + bytesRead,
                      remaining: remaining - bytesRead
                    }
                  ] as const
              )
            )
          }
        )
      }
    )
  )

/**
 * Constructs a `FileSystem` over a ZenFS-shaped backend.
 *
 * Only the operations a browser backend can actually serve are wired up.
 * Everything else keeps `FileSystem.makeNoop`'s behaviour — a `NotFound`
 * failure — which is the honest answer for a backend that has no symlinks,
 * writable handles, or watchers: `chmod`, `chown`, `copy`, `copyFile`, `glob`,
 * `link`, `symlink`, `readLink`, `open`, `rename`, `sink`, `truncate`,
 * `utimes`, `watch`, and the `makeTemp*` family all fail rather than pretend.
 * `sink` is in that list because the slice has no writable file handle to
 * append through, so there is no way to honour its incremental contract.
 * Reads use bounded file-handle chunks rather than loading the whole file.
 * `readFileString` and `writeFileString` are wired explicitly, because
 * `makeNoop` — unlike `make` — does not derive them. Each gap that
 * turns out to matter becomes a ticket, not a silently-wrong implementation
 * (`Concepts/Tickets Not Exceptions.md`).
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (fs: ZenFsPromisesLike): FileSystem.FileSystem =>
  FileSystem.makeNoop({
    readFile: (path) => readBytes(fs, path),
    stream: (path, options) => streamFile(fs, path, options),
    writeFile: (path, data, options) => writeBytes(fs, path, data, options),
    /**
     * `makeNoop` does not derive the string helpers from `readFile`/`writeFile`
     * the way `make` does — it hardcodes both to a `NotFound` failure — so they
     * have to be wired explicitly, with the same encode/decode error handling
     * effect's own `make` uses.
     */
    readFileString: (path, encoding) =>
      Effect.flatMap(readBytes(fs, path), (bytes) =>
        Effect.try({
          try: () => new TextDecoder(encoding).decode(bytes),
          catch: (cause) =>
            PlatformError.badArgument({
              module: "FileSystem",
              method: "readFileString",
              description: "invalid encoding",
              cause
            })
        })),
    writeFileString: (path, data, options) =>
      Effect.flatMap(
        Effect.try({
          try: () => new TextEncoder().encode(data),
          catch: (cause) =>
            PlatformError.badArgument({
              module: "FileSystem",
              method: "writeFileString",
              description: "could not encode string",
              cause
            })
        }),
        (bytes) => writeBytes(fs, path, bytes, options)
      ),
    makeDirectory: (path, options) =>
      Effect.asVoid(
        Effect.tryPromise({
          try: () => fs.mkdir(path, { recursive: options?.recursive ?? false }),
          catch: platformError("makeDirectory", path)
        })
      ),
    readDirectory: (path) =>
      Effect.tryPromise({ try: () => fs.readdir(path), catch: platformError("readDirectory", path) }),
    stat: (path) =>
      Effect.map(
        Effect.tryPromise({ try: () => fs.stat(path), catch: platformError("stat", path) }),
        fileInfo
      ),
    realPath: (path) =>
      Effect.as(
        Effect.tryPromise({ try: () => fs.stat(path), catch: platformError("realPath", path) }),
        path
      ),
    remove: (path, options) =>
      Effect.tryPromise({
        try: () =>
          fs.rm(path, {
            recursive: options?.recursive ?? false,
            force: options?.force ?? false
          }),
        catch: platformError("remove", path)
      }),
    access: (path) =>
      Effect.asVoid(
        Effect.tryPromise({ try: () => fs.stat(path), catch: platformError("access", path) })
      ),
    /**
     * `makeNoop` hardcodes `exists` to `false` (it does not derive it from
     * `access` the way `make` does), so it has to be overridden explicitly.
     */
    exists: (path) =>
      Effect.match(
        Effect.tryPromise({ try: () => fs.stat(path), catch: platformError("exists", path) }),
        { onFailure: () => false, onSuccess: () => true }
      )
  })

/**
 * Provides the `FileSystem` service backed by a ZenFS-shaped promises API.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (fs: ZenFsPromisesLike): Layer.Layer<FileSystem.FileSystem> =>
  Layer.succeed(FileSystem.FileSystem)(make(fs))
