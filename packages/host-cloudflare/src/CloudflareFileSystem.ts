/** Cloudflare object-storage filesystem. Directories are explicit `.flows-dir` objects. @since 0.1.0 */
import { Effect, FileSystem, Layer, Option, PlatformError, Stream } from "effect"

/** Injected R2/DO object binding. No Cloudflare global is read by this module. @category models @since 0.1.0 */
export interface ObjectStore {
  readonly get: (key: string) => Promise<Uint8Array | undefined>
  readonly put: (key: string, value: Uint8Array) => Promise<void>
  readonly delete: (key: string) => Promise<void>
  readonly list: (prefix: string) => Promise<ReadonlyArray<string>>
}
const directoryMarker = (path: string) => `${path.replace(/\/$/, "")}/.flows-dir`
const error = (method: string, path: string) => (cause: unknown) =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "FileSystem",
    method,
    pathOrDescriptor: path,
    description: cause instanceof Error ? cause.message : String(cause),
    cause
  })
const notFound = (method: string, path: string) =>
  PlatformError.systemError({
    _tag: "NotFound",
    module: "FileSystem",
    method,
    pathOrDescriptor: path,
    description: "object does not exist"
  })
/** Creates a FileSystem over an injected object store. `watch` is deliberately unsupported: object stores have no change feed. TICKET: `.smithers/tickets/cloudflare-filesystem-watch.md`. @category constructors @since 0.1.0 */
export const make = (store: ObjectStore): FileSystem.FileSystem =>
  FileSystem.makeNoop({
    readFile: Effect.fn("CloudflareFileSystem.readFile")((path) =>
      Effect.flatMap(Effect.tryPromise({ try: () => store.get(path), catch: error("readFile", path) }), (value) =>
        value === undefined ? Effect.fail(notFound("readFile", path)) : Effect.succeed(value))
    ),
    writeFile: Effect.fn("CloudflareFileSystem.writeFile")((path, data) =>
      Effect.tryPromise({
        try: () =>
          store.put(path, data),
        catch: error("writeFile", path)
      })
    ),
    makeDirectory: Effect.fn("CloudflareFileSystem.makeDirectory")((path) =>
      Effect.tryPromise({
        try: () => store.put(directoryMarker(path), new Uint8Array()),
        catch: error("makeDirectory", path)
      })
    ),
    readDirectory: Effect.fn("CloudflareFileSystem.readDirectory")((path) =>
      Effect.map(
        Effect.tryPromise({
          try: () => store.list(`${path.replace(/\/$/, "")}/`),
          catch: error("readDirectory", path)
        }),
        (
          keys
        ) => [
          ...new Set(
            keys.map((key) => key.slice(path.replace(/\/$/, "").length + 1).split("/")[0]).filter((
              key
            ): key is string => key !== "" && key !== ".flows-dir")
          )
        ]
      )
    ),
    remove: Effect.fn("CloudflareFileSystem.remove")((path, options) =>
      Effect.flatMap(
        Effect.tryPromise({ try: () => store.list(`${path.replace(/\/$/, "")}/`), catch: error("remove", path) }),
        (keys) =>
          options?.recursive
            ? Effect.forEach(
              [...keys, path],
              (key) => Effect.tryPromise({ try: () => store.delete(key), catch: error("remove", key) })
            ).pipe(Effect.asVoid)
            : Effect.tryPromise({ try: () => store.delete(path), catch: error("remove", path) })
      )
    ),
    exists: Effect.fn("CloudflareFileSystem.exists")((path) =>
      Effect.map(
        Effect.tryPromise({ try: () => store.get(path), catch: error("exists", path) }),
        (value) => value !== undefined
      )
    ),
    access: Effect.fn("CloudflareFileSystem.access")((path) =>
      Effect.flatMap(
        Effect.tryPromise({ try: () => store.get(path), catch: error("access", path) }),
        (value) => value === undefined ? Effect.fail(notFound("access", path)) : Effect.void
      )
    ),
    stat: Effect.fn("CloudflareFileSystem.stat")((path) =>
      Effect.flatMap(
        Effect.tryPromise({ try: () => store.get(path), catch: error("stat", path) }),
        (value) =>
          value === undefined ? Effect.fail(notFound("stat", path)) : Effect.succeed({
            type: "File" as const,
            mtime: Option.none(),
            atime: Option.none(),
            birthtime: Option.none(),
            dev: 0,
            ino: Option.none(),
            mode: 0o666,
            nlink: Option.none(),
            uid: Option.none(),
            gid: Option.none(),
            rdev: Option.none(),
            size: FileSystem.Size(value.byteLength),
            blksize: Option.none(),
            blocks: Option.none()
          })
      )
    ),
    realPath: Effect.fn("CloudflareFileSystem.realPath")((path) => Effect.succeed(path)),
    stream: (path) =>
      Stream.fromEffect(
        Effect.fn("CloudflareFileSystem.stream")(() =>
          Effect.flatMap(
            Effect.tryPromise({ try: () => store.get(path), catch: error("stream", path) }),
            (value) => value === undefined ? Effect.fail(notFound("stream", path)) : Effect.succeed(value)
          )
        )()
      ),
    // TICKET: .smithers/tickets/cloudflare-filesystem-watch.md
    watch: (path) =>
      Stream.fail(
        PlatformError.systemError({
          _tag: "Unknown",
          module: "FileSystem",
          method: "watch",
          pathOrDescriptor: path,
          description: "Cloudflare object storage does not provide a watch API"
        })
      )
  })
/** @category layers @since 0.1.0 */
export const layer = (store: ObjectStore): Layer.Layer<FileSystem.FileSystem> =>
  Layer.succeed(FileSystem.FileSystem)(make(store))
