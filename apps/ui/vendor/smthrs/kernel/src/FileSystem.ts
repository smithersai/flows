/**
 * Permission-aware filesystem operations.
 *
 * There is no kernel `FileSystem` interface and no kernel `FileSystem` tag.
 * Effect owns both, and its tag fixes the error channel to `PlatformError`, so
 * this module is only the middleware: a `Layer` over Effect's own tag that
 * reads the raw service out of context and returns a guarded one in its place.
 * Permission failures are projected into `PlatformError` by
 * `Permission.toPlatformError`, which keeps the structured kernel failure on
 * the error's `cause`.
 *
 * Governing design:
 * `docs/specs/Concepts/Permission Kernel.md`,
 * `docs/specs/Concepts/Effect Taxonomy.md`, and
 * `docs/specs/Concepts/Host Adapters.md`.
 *
 * @since 0.1.0
 */
import { make as makeCapability } from "@smthrs/capability/Capability"
import { permissionDenied, type PermissionError, toPlatformError } from "@smthrs/capability/Permission"
import {
  Effect,
  FileSystem as EffectFileSystem,
  Layer,
  Option,
  Path as EffectPath,
  type PlatformError,
  Sink,
  Stream
} from "effect"
import { GrantStore } from "./GrantStore.ts"
import { Workspace } from "./Workspace.ts"

const FileSystemTypeId = "~effect/platform/FileSystem"

const readableOpenFlags: ReadonlySet<EffectFileSystem.OpenFlag> = new Set([
  "r",
  "r+",
  "w+",
  "wx+",
  "a+",
  "ax+"
])

const writableOpenFlags: ReadonlySet<EffectFileSystem.OpenFlag> = new Set([
  "r+",
  "w",
  "wx",
  "w+",
  "wx+",
  "a",
  "ax",
  "a+",
  "ax+"
])

const isInside = (path: EffectPath.Path, root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate)
  return relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

/**
 * Resolves a path through every existing ancestor and maps paths inside the
 * canonical workspace back to the stable logical workspace root. Existing
 * symlinks therefore cannot turn an inside-workspace grant into outside
 * authority, while capability resources remain stable when the root itself is
 * a symlink.
 *
 * @category security
 * @since 0.1.0
 */
export const canonicalResource = (
  fileSystem: EffectFileSystem.FileSystem,
  path: EffectPath.Path,
  workspaceRoot: string,
  value: string
): Effect.Effect<string, PlatformError.PlatformError> => {
  const normalizedRoot = path.normalize(workspaceRoot)
  const normalizedValue = path.normalize(
    path.isAbsolute(value) ? value : path.resolve(normalizedRoot, value)
  )
  const resolveExistingAncestor = (
    candidate: string,
    symlinkDepth = 0
  ): Effect.Effect<string, PlatformError.PlatformError> =>
    fileSystem.realPath(candidate).pipe(
      Effect.catch((error) => {
        const resolveParent = () => {
          const parent = path.dirname(candidate)
          if (parent === candidate) {
            return Effect.fail(error)
          }
          return resolveExistingAncestor(parent, symlinkDepth).pipe(
            Effect.map((resolvedParent) => path.join(resolvedParent, path.basename(candidate)))
          )
        }
        return fileSystem.readLink(candidate).pipe(
          Effect.matchEffect({
            onFailure: resolveParent,
            onSuccess: (target) =>
              symlinkDepth >= 40
                ? Effect.fail(error)
                : resolveExistingAncestor(
                  path.isAbsolute(target) ? target : path.resolve(path.dirname(candidate), target),
                  symlinkDepth + 1
                )
          })
        )
      })
    )

  return Effect.all([
    fileSystem.realPath(normalizedRoot),
    resolveExistingAncestor(normalizedValue)
  ]).pipe(
    Effect.map(([canonicalRoot, canonicalValue]) =>
      isInside(path, canonicalRoot, canonicalValue)
        ? path.normalize(path.join(normalizedRoot, path.relative(canonicalRoot, canonicalValue)))
        : path.normalize(canonicalValue)
    )
  )
}

/**
 * Decorates Effect's filesystem service in place with workspace-normalized
 * capability checks. Canonical-path and hard-link guards are always evaluated
 * before the capability check and delegate acquisition.
 *
 * The layer provides the tag it also requires: compose it over a host
 * filesystem layer with `Layer.provide` and every consumer of
 * `FileSystem.FileSystem` — including one that never heard of the kernel —
 * resolves the guarded implementation. A denied request surfaces as a
 * `PlatformError` whose reason is `PermissionDenied` and whose `cause` is the
 * kernel's own `PermissionRequired`, `PermissionDenied`, or `GrantStoreError`;
 * `Permission.fromPlatformError` reads it back.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<
  EffectFileSystem.FileSystem,
  PlatformError.PlatformError,
  EffectFileSystem.FileSystem | EffectPath.Path | Workspace | GrantStore
> = Layer.effect(
  EffectFileSystem.FileSystem,
  Effect.gen(function*() {
    const fileSystem = yield* EffectFileSystem.FileSystem
    const path = yield* EffectPath.Path
    const workspace = yield* Workspace
    const grants = yield* GrantStore
    const normalizeFrom = (base: string, value: string): string =>
      path.normalize(path.isAbsolute(value) ? value : path.resolve(base, value))
    const normalize = (value: string): string => normalizeFrom(workspace.root, value)
    yield* fileSystem.realPath(normalize(workspace.root))
    const refuse = (method: string, resource: string) => (error: PermissionError): PlatformError.PlatformError =>
      toPlatformError({ module: "FileSystem", method, pathOrDescriptor: resource, error })
    const guard = (
      action: "fs:read" | "fs:write",
      value: string
    ): Effect.Effect<void, PlatformError.PlatformError> => {
      const normalized = normalize(value)
      const method = action === "fs:read" ? "read" : "write"
      return canonicalResource(fileSystem, path, workspace.root, normalized).pipe(
        Effect.flatMap((resource) =>
          fileSystem.stat(normalized).pipe(
            Effect.matchEffect({
              onFailure: () => grants.check(makeCapability(action, resource)),
              onSuccess: (info) => {
                const hardLinked = info.type === "File" && Option.isSome(info.nlink) && info.nlink.value > 1
                return hardLinked
                  ? Effect.fail(
                    permissionDenied(
                      makeCapability(action, resource),
                      "hard-linked files cannot be confined to the workspace"
                    )
                  )
                  : grants.check(makeCapability(action, resource))
              }
            }),
            Effect.mapError(refuse(method, resource))
          )
        )
      )
    }
    const read = (value: string) => guard("fs:read", value)
    const write = (value: string) => guard("fs:write", value)
    const readWrite = (from: string, to: string) => read(from).pipe(Effect.andThen(write(to)))
    const writeWrite = (from: string, to: string) => write(from).pipe(Effect.andThen(write(to)))
    const temp = (directory: string | undefined) =>
      directory === undefined
        ? write(path.resolve(workspace.root, "..", "<system-temp>"))
        : write(directory)
    const normalizeTempOptions = <T extends { readonly directory?: string | undefined }>(options: T | undefined) =>
      options?.directory === undefined ? options : { ...options, directory: normalize(options.directory) }
    const openChecks = (value: string, flag: EffectFileSystem.OpenFlag) => {
      const readable = readableOpenFlags.has(flag)
      const writable = writableOpenFlags.has(flag)
      return readable && writable ?
        read(value).pipe(Effect.andThen(write(value))) :
        writable ?
        write(value) :
        read(value)
    }
    const wrapFile = (file: EffectFileSystem.File, value: string): EffectFileSystem.File => ({
      [EffectFileSystem.FileTypeId]: EffectFileSystem.FileTypeId,
      fd: file.fd,
      stat: Effect.fn("FileSystem.File.stat")(() =>
        Effect.suspend(() => read(value).pipe(Effect.andThen(file.stat)))
      )(),
      seek: Effect.fn("FileSystem.File.seek")(file.seek),
      sync: Effect.fn("FileSystem.File.sync")(() =>
        Effect.suspend(() => write(value).pipe(Effect.andThen(file.sync)))
      )(),
      read: Effect.fn("FileSystem.File.read")((buffer) => read(value).pipe(Effect.andThen(file.read(buffer)))),
      readAlloc: Effect.fn("FileSystem.File.readAlloc")((size) =>
        read(value).pipe(Effect.andThen(file.readAlloc(size)))
      ),
      truncate: Effect.fn("FileSystem.File.truncate")((length) =>
        write(value).pipe(Effect.andThen(file.truncate(length)))
      ),
      write: Effect.fn("FileSystem.File.write")((buffer) => write(value).pipe(Effect.andThen(file.write(buffer)))),
      writeAll: Effect.fn("FileSystem.File.writeAll")((buffer) =>
        write(value).pipe(Effect.andThen(file.writeAll(buffer)))
      )
    })
    const guarded: EffectFileSystem.FileSystem = {
      [FileSystemTypeId]: FileSystemTypeId,
      access: Effect.fn("FileSystem.access")((value, options) =>
        read(value).pipe(Effect.andThen(fileSystem.access(normalize(value), options)))
      ),
      copy: Effect.fn("FileSystem.copy")((from, to, options) =>
        readWrite(from, to).pipe(Effect.andThen(fileSystem.copy(normalize(from), normalize(to), options)))
      ),
      copyFile: Effect.fn("FileSystem.copyFile")((from, to) =>
        readWrite(from, to).pipe(Effect.andThen(fileSystem.copyFile(normalize(from), normalize(to))))
      ),
      chmod: Effect.fn("FileSystem.chmod")((value, mode) =>
        write(value).pipe(Effect.andThen(fileSystem.chmod(normalize(value), mode)))
      ),
      chown: Effect.fn("FileSystem.chown")((value, uid, gid) =>
        write(value).pipe(Effect.andThen(fileSystem.chown(normalize(value), uid, gid)))
      ),
      glob: Effect.fn("FileSystem.glob")((pattern, options) => {
        const root = options?.root === undefined ? workspace.root : normalize(options.root)
        const normalizedPattern = normalizeFrom(root, pattern)
        return read(normalizedPattern).pipe(
          Effect.andThen(
            fileSystem.glob(
              normalizedPattern,
              options?.root === undefined ? options : { ...options, root }
            )
          )
        )
      }),
      exists: Effect.fn("FileSystem.exists")((value) =>
        read(value).pipe(Effect.andThen(fileSystem.exists(normalize(value))))
      ),
      link: Effect.fn("FileSystem.link")((from, to) =>
        readWrite(from, to).pipe(Effect.andThen(fileSystem.link(normalize(from), normalize(to))))
      ),
      makeDirectory: Effect.fn("FileSystem.makeDirectory")((value, options) =>
        write(value).pipe(Effect.andThen(fileSystem.makeDirectory(normalize(value), options)))
      ),
      makeTempDirectory: Effect.fn("FileSystem.makeTempDirectory")((options) =>
        temp(options?.directory).pipe(Effect.andThen(fileSystem.makeTempDirectory(normalizeTempOptions(options))))
      ),
      makeTempDirectoryScoped: Effect.fn("FileSystem.makeTempDirectoryScoped")((options) =>
        temp(options?.directory).pipe(
          Effect.andThen(fileSystem.makeTempDirectoryScoped(normalizeTempOptions(options)))
        )
      ),
      makeTempFile: Effect.fn("FileSystem.makeTempFile")((options) =>
        temp(options?.directory).pipe(Effect.andThen(fileSystem.makeTempFile(normalizeTempOptions(options))))
      ),
      makeTempFileScoped: Effect.fn("FileSystem.makeTempFileScoped")((options) =>
        temp(options?.directory).pipe(Effect.andThen(fileSystem.makeTempFileScoped(normalizeTempOptions(options))))
      ),
      open: Effect.fn("FileSystem.open")((value, options) =>
        openChecks(value, options?.flag ?? "r").pipe(
          Effect.andThen(fileSystem.open(normalize(value), options)),
          Effect.map((file) => wrapFile(file, value))
        )
      ),
      readDirectory: Effect.fn("FileSystem.readDirectory")((value, options) =>
        read(value).pipe(Effect.andThen(fileSystem.readDirectory(normalize(value), options)))
      ),
      readFile: Effect.fn("FileSystem.readFile")((value) =>
        read(value).pipe(Effect.andThen(fileSystem.readFile(normalize(value))))
      ),
      readFileString: Effect.fn("FileSystem.readFileString")((value, encoding) =>
        read(value).pipe(Effect.andThen(fileSystem.readFileString(normalize(value), encoding)))
      ),
      readLink: Effect.fn("FileSystem.readLink")((value) =>
        read(value).pipe(Effect.andThen(fileSystem.readLink(normalize(value))))
      ),
      realPath: Effect.fn("FileSystem.realPath")((value) =>
        read(value).pipe(Effect.andThen(fileSystem.realPath(normalize(value))))
      ),
      remove: Effect.fn("FileSystem.remove")((value, options) =>
        write(value).pipe(Effect.andThen(fileSystem.remove(normalize(value), options)))
      ),
      rename: Effect.fn("FileSystem.rename")((from, to) =>
        writeWrite(from, to).pipe(Effect.andThen(fileSystem.rename(normalize(from), normalize(to))))
      ),
      sink: (value, options) =>
        Sink.unwrap(
          Effect.fn("FileSystem.sink")(
            () => Effect.suspend(() => write(value).pipe(Effect.map(() => fileSystem.sink(normalize(value), options))))
          )()
        ),
      stat: Effect.fn("FileSystem.stat")((value) =>
        read(value).pipe(Effect.andThen(fileSystem.stat(normalize(value))))
      ),
      stream: (value, options) =>
        Stream.unwrap(
          Effect.fn("FileSystem.stream")(() =>
            Effect.suspend(() => read(value).pipe(Effect.map(() => fileSystem.stream(normalize(value), options))))
          )()
        ),
      symlink: Effect.fn("FileSystem.symlink")((from, to) =>
        write(to).pipe(Effect.andThen(fileSystem.symlink(from, normalize(to))))
      ),
      truncate: Effect.fn("FileSystem.truncate")((value, length) =>
        write(value).pipe(Effect.andThen(fileSystem.truncate(normalize(value), length)))
      ),
      utimes: Effect.fn("FileSystem.utimes")((value, atime, mtime) =>
        write(value).pipe(Effect.andThen(fileSystem.utimes(normalize(value), atime, mtime)))
      ),
      watch: (value) =>
        Stream.unwrap(
          Effect.fn("FileSystem.watch")(() =>
            Effect.suspend(() => read(value).pipe(Effect.map(() => fileSystem.watch(normalize(value)))))
          )()
        ),
      writeFile: Effect.fn("FileSystem.writeFile")((value, data, options) =>
        write(value).pipe(Effect.andThen(fileSystem.writeFile(normalize(value), data, options)))
      ),
      writeFileString: Effect.fn("FileSystem.writeFileString")((value, data, options) =>
        write(value).pipe(Effect.andThen(fileSystem.writeFileString(normalize(value), data, options)))
      )
    }
    return guarded
  })
)
