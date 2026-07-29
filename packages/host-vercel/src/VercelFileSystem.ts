/**
 * Persistent Vercel Blob/KV filesystem adapter.
 *
 * Object storage has no native directories, file handles, or change
 * notifications. Directories are therefore inferred from key prefixes and
 * `watch` reports a typed platform failure. Bindings are structural so the
 * edge entry point does not import the Vercel SDK or any Node module.
 *
 * @since 0.1.0
 */
import { Effect, FileSystem, Layer, Option, PlatformError, Stream } from "effect"

/** The subset of `@vercel/blob` used by this adapter. @category models */
export interface BlobBinding {
  readonly get: (pathname: string) => Promise<{ readonly arrayBuffer: () => Promise<ArrayBuffer> } | null>
  readonly put: (pathname: string, body: Uint8Array) => Promise<unknown>
  readonly del: (pathname: string) => Promise<unknown>
  readonly list: (options?: { readonly prefix?: string }) => Promise<{
    readonly blobs: ReadonlyArray<{ readonly pathname: string }>
  }>
}

/** The subset of a Vercel KV-compatible binding used by this adapter. @category models */
export interface KvBinding {
  readonly get: (key: string) => Promise<Uint8Array | null>
  readonly set: (key: string, value: Uint8Array) => Promise<unknown>
  readonly del: (key: string) => Promise<unknown>
  readonly scan: (prefix?: string) => Promise<ReadonlyArray<string>>
}

/** A persistent object binding supplied by the application at the edge. @category models */
export type Storage =
  | { readonly blob: BlobBinding }
  | { readonly kv: KvBinding }

const normalize = (path: string): string => {
  const parts: Array<string> = []
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") parts.pop()
    else parts.push(part)
  }
  return `/${parts.join("/")}`
}

const keyOf = (path: string): string => normalize(path).slice(1)

const hasCode = (cause: unknown, code: string): boolean =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === code

const platformError = (method: string, path: string) => (cause: unknown): PlatformError.PlatformError =>
  PlatformError.systemError({
    _tag: hasCode(cause, "ENOENT") ? "NotFound" : hasCode(cause, "EEXIST") ? "AlreadyExists" : "Unknown",
    module: "VercelFileSystem",
    method,
    pathOrDescriptor: path,
    description: cause instanceof Error ? cause.message : String(cause),
    cause
  })

const listKeys = Effect.fn("VercelFileSystem.listKeys")((
  storage: Storage,
  prefix = ""
): Effect.Effect<ReadonlyArray<string>, PlatformError.PlatformError> =>
  Effect.tryPromise({
    try: async () => {
      if ("blob" in storage) {
        const result = await storage.blob.list(prefix === "" ? undefined : { prefix })
        return result.blobs.map((blob) => blob.pathname)
      }
      return storage.kv.scan(prefix)
    },
    catch: platformError("list", prefix)
  })
)

const readBytes = Effect.fn("VercelFileSystem.readFile")((
  storage: Storage,
  path: string
): Effect.Effect<Uint8Array, PlatformError.PlatformError> =>
  Effect.tryPromise({
    try: async () => {
      const key = keyOf(path)
      if ("blob" in storage) {
        const value = await storage.blob.get(key)
        if (value === null) throw Object.assign(new Error(`not found: ${path}`), { code: "ENOENT" })
        return new Uint8Array(await value.arrayBuffer())
      }
      const value = await storage.kv.get(key)
      if (value === null) throw Object.assign(new Error(`not found: ${path}`), { code: "ENOENT" })
      return value
    },
    catch: platformError("readFile", path)
  })
)

const writeBytes = Effect.fn("VercelFileSystem.writeFile")((
  storage: Storage,
  path: string,
  data: Uint8Array
): Effect.Effect<void, PlatformError.PlatformError> =>
  Effect.tryPromise({
    try: async () => {
      const key = keyOf(path)
      if ("blob" in storage) await storage.blob.put(key, data)
      else await storage.kv.set(key, data)
    },
    catch: platformError("writeFile", path)
  })
)

const fileInfo = (size: number): FileSystem.File.Info => ({
  type: "File",
  mtime: Option.none(),
  atime: Option.none(),
  birthtime: Option.none(),
  dev: 0,
  ino: Option.none(),
  mode: 0o100644,
  nlink: Option.none(),
  uid: Option.none(),
  gid: Option.none(),
  rdev: Option.none(),
  size: FileSystem.Size(size),
  blksize: Option.none(),
  blocks: Option.none()
})

const directChildren = (path: string, keys: ReadonlyArray<string>): Array<string> => {
  const prefix = keyOf(path)
  const start = prefix === "" ? "" : `${prefix}/`
  const names = new Set<string>()
  for (const key of keys) {
    if (!key.startsWith(start)) continue
    const rest = key.slice(start.length)
    const name = rest.split("/")[0]
    if (name !== undefined && name !== "") names.add(name)
  }
  return [...names].sort()
}

/** Builds a filesystem over one Vercel Blob or KV binding. @category constructors @since 0.1.0 */
export const make = (storage: Storage): FileSystem.FileSystem =>
  FileSystem.makeNoop({
    readFile: (path) => readBytes(storage, path),
    readFileString: (path, encoding) =>
      readBytes(storage, path).pipe(Effect.map((data) =>
        new TextDecoder(encoding === undefined || encoding === "utf8" ? "utf-8" : encoding).decode(data)
      )),
    writeFile: (path, data) =>
      writeBytes(storage, path, data),
    makeDirectory: (path) => Effect.asVoid(listKeys(storage, keyOf(path))),
    readDirectory: (path) => listKeys(storage).pipe(Effect.map((keys) => directChildren(path, keys))),
    stat: (path) =>
      readBytes(storage, path).pipe(
        Effect.map((data) => fileInfo(data.byteLength)),
        Effect.catch(() =>
          listKeys(storage, `${keyOf(path)}/`).pipe(
            Effect.flatMap((keys) =>
              keys.length === 0 ? Effect.fail(platformError("stat", path)(new Error("not found"))) : Effect.succeed({
                ...fileInfo(0),
                type: "Directory" as const,
                mode: 0o040755
              })
            )
          )
        )
      ),
    realPath: (path) => Effect.as(readBytes(storage, path), normalize(path)),
    access: (path) => Effect.asVoid(readBytes(storage, path)),
    exists: (path) => Effect.match(readBytes(storage, path), { onFailure: () => false, onSuccess: () => true }),
    remove: (path, options) =>
      listKeys(storage, keyOf(path)).pipe(
        Effect.flatMap((keys) => {
          const target = keyOf(path)
          const matches = keys.filter((key) =>
            key === target || (options?.recursive === true && key.startsWith(`${target}/`))
          )
          if (matches.length === 0) return Effect.fail(platformError("remove", path)(new Error("not found")))
          return Effect.forEach(matches, (key) =>
            Effect.tryPromise({
              try: () => "blob" in storage ? storage.blob.del(key) : storage.kv.del(key),
              catch: platformError("remove", path)
            })).pipe(Effect.asVoid)
        })
      ),
    stream: (path, options) =>
      Stream.unwrap(
        readBytes(storage, path).pipe(
          Effect.map((data) => {
            const offset = Math.max(0, Number(options?.offset ?? 0))
            const limit = options?.bytesToRead === undefined
              ? data.byteLength
              : Math.max(0, Number(options.bytesToRead))
            const chunkSize = Math.max(1, Number(options?.chunkSize ?? 64 * 1024))
            const selected = data.subarray(offset, offset + limit)
            const chunks: Array<Uint8Array> = []
            for (let index = 0; index < selected.byteLength; index += chunkSize) {
              chunks.push(selected.subarray(index, index + chunkSize))
            }
            return Stream.fromIterable(chunks)
          })
        )
      ),
    // TICKET: Vercel Blob/KV filesystem watch — see .smithers/tickets/vercel-blob-filesystem-watch.md
    watch: (path) =>
      Stream.fail(
        PlatformError.systemError({
          _tag: "Unknown",
          module: "VercelFileSystem",
          method: "watch",
          pathOrDescriptor: path,
          description: "Vercel Blob and KV do not provide change streams"
        })
      )
  })

/** Provides a Vercel Blob/KV-backed filesystem. @category layers @since 0.1.0 */
export const layer = (storage: Storage): Layer.Layer<FileSystem.FileSystem> =>
  Layer.succeed(FileSystem.FileSystem)(make(storage))
