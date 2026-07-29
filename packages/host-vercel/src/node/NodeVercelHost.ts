/**
 * Node runtime bundle for Vercel functions.
 *
 * This layer is invocation-lifetime only: `/tmp` is writable during one
 * function invocation but is not durable, may be reclaimed between
 * invocations, and must never be treated as persistent application storage.
 * Persistent state belongs in `VercelStore` or Blob/KV.
 *
 * @since 0.1.0
 */
import type { HttpTransport } from "@flows/host/HttpTransport"
import type { Jj } from "@flows/host/Jj"
import * as NodeHttpTransport from "@flows/host/node/NodeHttpTransport"
import * as NodeJj from "@flows/host/node/NodeJj"
import * as NodePty from "@flows/host/node/NodePty"
import * as NodeShell from "@flows/host/node/NodeShell"
import type { Pty } from "@flows/host/Pty"
import type { Shell } from "@flows/host/Shell"
import type { FileSystem } from "effect"
import { Effect, FileSystem as EffectFileSystem, Layer, Option, Path, PlatformError, Stream } from "effect"
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"

const insideTmp = (root: string, path: string): string => {
  const resolved = NodePath.resolve(root, path)
  if (resolved !== root && !resolved.startsWith(`${root}${NodePath.sep}`)) {
    throw new Error(`path escapes Vercel /tmp root: ${path}`)
  }
  return resolved
}

const platformError = (method: string, path: string) => (cause: unknown): PlatformError.PlatformError =>
  PlatformError.systemError({
    _tag: typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT"
      ? "NotFound"
      : "Unknown",
    module: "NodeVercelFileSystem",
    method,
    pathOrDescriptor: path,
    description: cause instanceof Error ? cause.message : String(cause),
    cause
  })

const layerFileSystem = (root: string): Layer.Layer<FileSystem.FileSystem> => {
  const safePath = (path: string, method: string): Effect.Effect<string, PlatformError.PlatformError> =>
    Effect.try({ try: () => insideTmp(root, path), catch: platformError(method, path) })
  const fs = EffectFileSystem.makeNoop({
    readFile: (path) =>
      safePath(path, "readFile").pipe(
        Effect.flatMap((value) =>
          Effect.tryPromise({ try: () => Fs.readFile(value), catch: platformError("readFile", path) })
        )
      ),
    readFileString: (path, encoding) =>
      safePath(path, "readFileString").pipe(
        Effect.flatMap((value) =>
          Effect.tryPromise({
            try: () => Fs.readFile(value, encoding as BufferEncoding | undefined),
            catch: platformError("readFileString", path)
          })
        ),
        Effect.map((data) => data.toString(encoding as BufferEncoding | undefined))
      ),
    writeFile: (path, data) =>
      safePath(path, "writeFile").pipe(
        Effect.flatMap((value) =>
          Effect.tryPromise({ try: () => Fs.writeFile(value, data), catch: platformError("writeFile", path) })
        )
      ),
    makeDirectory: (path, options) =>
      safePath(path, "makeDirectory").pipe(
        Effect.flatMap((value) =>
          Effect.tryPromise({
            try: () => Fs.mkdir(value, { recursive: options?.recursive ?? false }),
            catch: platformError("makeDirectory", path)
          })
        ),
        Effect.asVoid
      ),
    readDirectory: (path) =>
      safePath(path, "readDirectory").pipe(
        Effect.flatMap((value) =>
          Effect.tryPromise({ try: () => Fs.readdir(value), catch: platformError("readDirectory", path) })
        )
      ),
    remove: (path, options) =>
      safePath(path, "remove").pipe(
        Effect.flatMap((value) =>
          Effect.tryPromise({
            try: () => Fs.rm(value, { recursive: options?.recursive ?? false, force: options?.force ?? false }),
            catch: platformError("remove", path)
          })
        )
      ),
    stat: (path) =>
      safePath(path, "stat").pipe(Effect.flatMap((value) =>
        Effect.tryPromise({
          try: async () => {
            const stats = await Fs.stat(value)
            return {
              type: stats.isFile() ? "File" as const : stats.isDirectory() ? "Directory" as const : "Unknown" as const,
              mtime: Option.some(stats.mtime),
              atime: Option.some(stats.atime),
              birthtime: Option.some(stats.birthtime),
              dev: stats.dev,
              ino: Option.some(stats.ino),
              mode: stats.mode,
              nlink: Option.some(stats.nlink),
              uid: Option.some(stats.uid),
              gid: Option.some(stats.gid),
              rdev: Option.some(stats.rdev),
              size: EffectFileSystem.Size(stats.size),
              blksize: Option.some(EffectFileSystem.Size(stats.blksize)),
              blocks: Option.some(stats.blocks)
            }
          },
          catch: platformError("stat", path)
        })
      )),
    realPath: (path) =>
      safePath(path, "realPath").pipe(
        Effect.flatMap((value) =>
          Effect.tryPromise({ try: () => Fs.realpath(value), catch: platformError("realPath", path) })
        )
      ),
    access: (path) =>
      safePath(path, "access").pipe(
        Effect.flatMap((value) =>
          Effect.tryPromise({ try: () => Fs.access(value), catch: platformError("access", path) })
        ),
        Effect.asVoid
      ),
    exists: (path) =>
      safePath(path, "exists").pipe(
        Effect.flatMap((value) =>
          Effect.promise(async () => {
            try {
              await Fs.stat(value)
              return true
            } catch {
              return false
            }
          })
        ),
        Effect.catch(() => Effect.succeed(false))
      ),
    stream: (path, options) =>
      Stream.unwrap(
        safePath(path, "stream").pipe(
          Effect.flatMap((value) =>
            Effect.tryPromise({ try: () => Fs.readFile(value), catch: platformError("stream", path) })
          ),
          Effect.map((data) => {
            const offset = Number(options?.offset ?? 0)
            const end = options?.bytesToRead === undefined ? data.byteLength : offset + Number(options.bytesToRead)
            const chunkSize = Math.max(1, Number(options?.chunkSize ?? 64 * 1024))
            const chunks: Array<Uint8Array> = []
            for (let index = offset; index < Math.min(data.byteLength, end); index += chunkSize) {
              chunks.push(data.subarray(index, Math.min(data.byteLength, index + chunkSize)))
            }
            return Stream.fromIterable(chunks)
          })
        )
      )
  })
  return Layer.succeed(EffectFileSystem.FileSystem)(fs)
}

/** Union of the six services supplied by the Node Vercel bundle. @category models @since 0.1.0 */
export type NodeVercelHost = FileSystem.FileSystem | Path.Path | Shell | Pty | Jj | HttpTransport

/** Provides a `/tmp`-confined invocation-lifetime Node host. @category layers @since 0.1.0 */
export const layerEphemeral = (root = "/tmp"): Layer.Layer<NodeVercelHost> =>
  Layer.mergeAll(
    layerFileSystem(NodePath.resolve(root)),
    Path.layer,
    NodeHttpTransport.layer,
    NodeShell.layer,
    NodePty.layer,
    NodeJj.layer
  )
