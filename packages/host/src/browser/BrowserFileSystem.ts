import { Effect, FileSystem, Layer, Option, PlatformError, Stream } from "effect"

/**
 * The slice of a ZenFS promises API we depend on.
 *
 * Satisfied by the **`@zenfs/core`** npm package's `fs.promises` export (and by
 * Node's own `node:fs/promises`, which is useful for a smoke test). We take the
 * object rather than importing the package so the browser bundle decides which
 * backend is mounted (IndexedDB, OPFS, in-memory) before handing it to us.
 */
export interface ZenFsPromisesLike {
  readonly open: (path: string, flags: "r") => Promise<ZenFsFileHandleLike>
  readonly readFile: (path: string) => Promise<Uint8Array>
  readonly writeFile: (path: string, data: Uint8Array) => Promise<void>
  readonly mkdir: (path: string, options?: { readonly recursive?: boolean }) => Promise<unknown>
  readonly readdir: (path: string) => Promise<Array<string>>
  readonly stat: (path: string) => Promise<ZenFsStatsLike>
  readonly rm: (
    path: string,
    options?: { readonly recursive?: boolean; readonly force?: boolean }
  ) => Promise<void>
}

/** The bounded-read slice shared by ZenFS and Node file handles. */
export interface ZenFsFileHandleLike {
  readonly read: (
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number
  ) => Promise<{ readonly bytesRead: number }>
  readonly close: () => Promise<void>
}

/** The subset of a ZenFS/Node `Stats` object `stat` needs. */
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
 * `FileSystem` over a ZenFS-shaped backend.
 *
 * Only the six operations `flows` actually issues in the browser are wired up.
 * Everything else keeps `makeNoop`'s behaviour — a `NotFound` failure — which
 * is the honest answer for a backend that has no symlinks, writable handles, or
 * watchers. Reads use bounded file-handle chunks rather than loading the whole
 * file. Each gap that turns out to matter becomes a ticket, not a
 * silently-wrong implementation (`Concepts/Tickets Not Exceptions.md`).
 */
export const make = (fs: ZenFsPromisesLike): FileSystem.FileSystem =>
  FileSystem.makeNoop({
    readFile: (path) => readBytes(fs, path),
    stream: (path, options) => streamFile(fs, path, options),
    writeFile: (path, data) =>
      Effect.tryPromise({
        try: () => fs.writeFile(path, data),
        catch: platformError("writeFile", path)
      }),
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

export const layer = (fs: ZenFsPromisesLike): Layer.Layer<FileSystem.FileSystem> =>
  Layer.succeed(FileSystem.FileSystem)(make(fs))
