/**
 * Copy-in projection of a declared file set into a scratch root.
 *
 * A target body normally runs against the whole workspace, so a file it reads
 * without declaring is invisible to the key that caches the result. Projection
 * removes the ambiguity by construction: it copies exactly the declared inputs
 * into an otherwise empty scratch root, the body runs there, and the declared
 * outputs are copied back. A file nobody declared simply is not present, so an
 * undeclared read fails where it happens instead of producing a stale cache
 * entry later.
 *
 * This is the sandboxed tier of `docs/specs/Concepts/Effect Taxonomy.md` —
 * seed the read set, run, collect the write set, which is Bazel's own strategy
 * — and it follows `@smthrs/engine-store`'s `WorkspaceSandbox`, this
 * repository's existing implementation of the same transaction.
 *
 * ## This is a determinism boundary, not a security boundary
 *
 * `WorkspaceSandbox`'s module doc states the limitation and it holds here
 * without change. Projection decides what a cooperating process finds when it
 * opens a declared path. It does not deny anything. A spawned native process
 * keeps the ambient authority of the user who spawned it: it can open an
 * absolute path, reach the network, and write anywhere the process may write,
 * and none of that passes through this module. Treat projection as the
 * mechanism that catches the undeclared-read bug class, never as a containment
 * mechanism for hostile code.
 *
 * ## Copies, not hard links
 *
 * A hard link would make projection nearly free, and it is refused anyway. A
 * hard link is the same inode under a second name, so a body that writes to
 * its scratch copy writes the workspace file. No platform this build system
 * runs on can prevent that: the mode bits are advisory to the file's owner,
 * who is the same user. The choice is therefore a copy, which is what the
 * instruction "hard link, unless the platform cannot guarantee the original is
 * immutable" resolves to on every host we support.
 *
 * ## Confinement
 *
 * Reads reuse {@link SafeFs}: {@link SafeFs.canonicalRoot} and
 * {@link SafeFs.inside} decide containment on canonical paths, and
 * {@link SafeFs.resolveFile} admits only a regular file whose whole resolution
 * stays inside the root. Projection is stricter than discovery in one place:
 * a symbolic link in the final component is refused rather than followed,
 * because a copy of a link's target is a different file under the declared
 * name, and the digest recorded for it would describe neither. Writes reuse
 * the publication shape of {@link GeneratedFile}: resolve every parent without
 * accepting a directory link, write an `O_EXCL` `O_NOFOLLOW` sibling
 * temporary, fsync it, re-check the parent's `dev:ino`, rename, fsync the
 * directory.
 *
 * ## Host access
 *
 * Every filesystem call goes through {@link Io}. {@link defaultIo} implements
 * it over `node:fs` and is the only implementation this package ships. A host
 * without `node:fs` — a browser, or the virtual filesystem the taxonomy's
 * browser tier describes — supplies its own {@link Io} rather than reaching a
 * silent exception, and a test supplies one that mutates a file between two
 * named calls so a traversal race is reproduced deterministically.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { createHash, randomUUID } from "node:crypto"
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"
import { failureMessage } from "./GeneratedFile.ts"
import * as Input from "./Input.ts"
import * as SafeFs from "./SafeFs.ts"
import * as Target from "./Target.ts"

/**
 * Maximum number of paths one projection may carry.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumProjectedFiles = 500_000

/**
 * Maximum length of one projected path, in UTF-8 bytes.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumProjectedPathBytes = 16 * 1024

/**
 * Maximum number of components in one projected path.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumProjectedPathDepth = 256

const directorySyncUnsupported: ReadonlySet<string> = new Set(["ENOTSUP", "EOPNOTSUPP", "EINVAL", "ENOSYS"])

/**
 * One file open for writing, reduced to the operations publication performs.
 *
 * `stat` must describe the open description itself, so a swap after the open
 * cannot change the answer, and `write` must either write every byte handed to
 * it or reject.
 *
 * @category models
 * @since 0.1.0
 */
export interface WriteFile {
  readonly stat: () => Promise<SafeFs.Stats>
  readonly write: (bytes: Uint8Array) => Promise<void>
  readonly sync: () => Promise<void>
  readonly close: () => Promise<void>
}

/**
 * The filesystem seam projection goes through.
 *
 * The read half is {@link SafeFs.Io} unchanged, so both halves of a transfer
 * admit files by the same rules. The write half is the smallest set of
 * operations confined publication needs. `create` must fail when the path
 * already exists and must never follow a symbolic link in the final
 * component.
 *
 * @category models
 * @since 0.1.0
 */
export interface Io extends SafeFs.Io {
  readonly mkdir: (path: string) => Promise<void>
  readonly create: (path: string, mode: number) => Promise<WriteFile>
  readonly rename: (from: string, to: string) => Promise<void>
  readonly remove: (path: string) => Promise<void>
  readonly syncDirectory: (path: string) => Promise<void>
}

const createFlags = NodeFs.constants.O_WRONLY |
  NodeFs.constants.O_CREAT |
  NodeFs.constants.O_EXCL |
  (NodeFs.constants.O_NOFOLLOW ?? 0)

/**
 * Projects through `node:fs`.
 *
 * @category execution
 * @since 0.1.0
 */
export const defaultIo: Io = {
  ...SafeFs.defaultIo,
  mkdir: (path) => Fs.mkdir(path),
  create: async (path, mode) => {
    const handle = await Fs.open(path, createFlags, mode)
    return {
      stat: () => handle.stat({ bigint: true }),
      write: async (bytes) => {
        let written = 0
        while (written < bytes.byteLength) {
          const result = await handle.write(bytes, written, bytes.byteLength - written, null)
          if (result.bytesWritten <= 0) throw new Error(`projected copy accepted no bytes at offset ${written}`)
          written += result.bytesWritten
        }
      },
      sync: () => handle.sync(),
      close: () => handle.close()
    }
  },
  rename: (from, to) => Fs.rename(from, to),
  remove: (path) => Fs.rm(path, { force: true }),
  syncDirectory: async (path) => {
    if (process.platform === "win32") return
    const handle = await Fs.open(path, "r")
    let primary: unknown
    try {
      await handle.sync()
    } catch (cause) {
      if (!directorySyncUnsupported.has(SafeFs.errorCode(cause) ?? "")) primary = cause
    }
    try {
      await handle.close()
    } catch (cause) {
      primary ??= cause
    }
    if (primary !== undefined) throw primary
  }
}

/**
 * One file that was copied, named by the workspace-relative path it was
 * declared under.
 *
 * The digest is of the bytes that actually moved, computed in the same pass
 * that wrote them, so it describes the copy and the original at once.
 *
 * @category models
 * @since 0.1.0
 */
export interface ProjectedFile {
  readonly path: string
  readonly bytes: number
  readonly digest: string
}

/**
 * The result of one transfer.
 *
 * `absent` lists the declared paths that named nothing. A declared file that
 * does not exist is not an error here, matching `WorkspaceSandbox.snapshot`:
 * the caller decides whether a missing input refuses a cache hit or a missing
 * output fails the target, and it needs the list to decide.
 *
 * @category models
 * @since 0.1.0
 */
export interface Projection {
  readonly from: string
  readonly to: string
  readonly files: ReadonlyArray<ProjectedFile>
  readonly absent: ReadonlyArray<string>
}

/**
 * How one transfer is performed.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  readonly io?: Io | undefined
  readonly signal?: AbortSignal | undefined
}

/**
 * A declared file set could not be projected or collected.
 *
 * @category errors
 * @since 0.1.0
 */
export class ProjectionError extends Schema.TaggedError<ProjectionError>()(
  "smithers-build/ProjectionError",
  {
    root: Schema.String,
    message: Schema.NonEmptyString
  }
) {}

/**
 * Normalizes one declared path to the workspace-relative form a transfer uses.
 *
 * The two existing definitions decide it. {@link Input.resolvePath} refuses an
 * absolute path, a parent traversal, a null byte, a backslash, and a drive
 * letter, and normalizes what is left. {@link Target.declaredOutputFailure}
 * refuses a path that names a directory rather than a file and one that
 * resolves inside a reserved root — `.git` and the `.flows` cache directory,
 * whose contents are the store a projection would otherwise digest out of.
 *
 * @category validation
 * @since 0.1.0
 */
export const resolveProjectedPath = (path: string): string => {
  const resolved = Input.resolvePath("", path)
  const failure = Target.declaredOutputFailure(".", resolved)
  if (failure !== undefined) throw new Error(`projected path is unusable: ${failure}`)
  const bytes = Buffer.byteLength(resolved, "utf8")
  if (bytes > maximumProjectedPathBytes) {
    throw new Error(`projected path exceeds ${maximumProjectedPathBytes} UTF-8 bytes`)
  }
  if (resolved.split("/").length > maximumProjectedPathDepth) {
    throw new Error(`projected path exceeds ${maximumProjectedPathDepth} components`)
  }
  return resolved
}

/** Identifies one filesystem object across two observations of it. */
const identity = (stats: SafeFs.Stats): string => `${stats.dev}:${stats.ino}`

/** Lossless non-negative size reported by one stat result. */
const sizeOf = (stats: SafeFs.Stats): bigint => {
  if (typeof stats.size === "bigint") return stats.size
  if (!Number.isSafeInteger(stats.size) || stats.size < 0) {
    throw new Error(`filesystem reported an invalid file size: ${String(stats.size)}`)
  }
  return BigInt(stats.size)
}

/** Lossless link count reported by one stat result. */
const linksOf = (stats: SafeFs.Stats): bigint => {
  if (typeof stats.nlink === "bigint") return stats.nlink
  if (!Number.isSafeInteger(stats.nlink) || stats.nlink < 0) {
    throw new Error(`filesystem reported an invalid link count: ${String(stats.nlink)}`)
  }
  return BigInt(stats.nlink)
}

/** Lossless timestamp where the host exposes nanoseconds, with a safe fallback. */
const timestamp = (stats: SafeFs.Stats, kind: "mtime" | "ctime"): string => {
  if ("mtimeNs" in stats && "ctimeNs" in stats) {
    return String(kind === "mtime" ? stats.mtimeNs : stats.ctimeNs)
  }
  const value = kind === "mtime" ? stats.mtimeMs : stats.ctimeMs
  return Number.isFinite(value) ? String(value) : "invalid"
}

/**
 * The permission bits one copy is created with.
 *
 * A scratch copy is private to the scratch tree, so it carries the owner bits
 * and the execute bit and nothing else: group and other access is not part of
 * what a declared input means. A file copied back into a workspace keeps the
 * mode of the file it replaces, and otherwise takes the conventional `0o666`
 * that `open` masks with the process umask.
 */
const modeFor = (source: SafeFs.Stats, existing: SafeFs.Stats | undefined, privateCopy: boolean): number => {
  if (existing !== undefined) return Number(BigInt(existing.mode) & 0o7777n)
  const executable = (BigInt(source.mode) & 0o111n) !== 0n
  if (privateCopy) return executable ? 0o700 : 0o600
  return executable ? 0o777 : 0o666
}

/**
 * Rejects a file that changed under the descriptor while it was being copied.
 */
const stable = (before: SafeFs.Stats, after: SafeFs.Stats, total: bigint): boolean =>
  identity(after) === identity(before) &&
  sizeOf(after) === sizeOf(before) &&
  timestamp(after, "mtime") === timestamp(before, "mtime") &&
  timestamp(after, "ctime") === timestamp(before, "ctime") &&
  total === sizeOf(before)

interface Directory {
  readonly path: string
  readonly stats: SafeFs.Stats
}

/** Resolves each parent component of one relative path without ever accepting a directory link. */
const prepareParent = async (
  root: string,
  relative: string,
  io: Io,
  signal: AbortSignal | undefined
): Promise<Directory> => {
  let current = root
  let currentStats = await io.lstat(current)
  if (!currentStats.isDirectory() || currentStats.isSymbolicLink()) {
    throw new Error(`projection root is not a real directory: ${root}`)
  }
  const segments = relative.split("/").slice(0, -1)
  for (const segment of segments) {
    signal?.throwIfAborted()
    const candidate = NodePath.join(current, segment)
    let stats: SafeFs.Stats
    try {
      stats = await io.lstat(candidate)
    } catch (cause) {
      if (SafeFs.errorCode(cause) !== "ENOENT") throw cause
      let created = false
      try {
        await io.mkdir(candidate)
        created = true
      } catch (mkdirCause) {
        if (SafeFs.errorCode(mkdirCause) !== "EEXIST") throw mkdirCause
      }
      if (created) await io.syncDirectory(current)
      stats = await io.lstat(candidate)
    }
    if (stats.isSymbolicLink()) throw new Error(`projection parent is a symbolic link: ${candidate}`)
    if (!stats.isDirectory()) throw new Error(`projection parent is not a directory: ${candidate}`)
    const real = await io.realpath(candidate)
    if (!SafeFs.inside(root, real)) throw new Error(`projection parent leaves the root: ${candidate}`)
    const resolved = await io.lstat(real)
    if (!resolved.isDirectory() || identity(resolved) !== identity(stats)) {
      throw new Error(`projection parent changed while it was being resolved: ${candidate}`)
    }
    current = real
    currentStats = resolved
  }
  return { path: current, stats: currentStats }
}

/** Rechecks the directory object held across temp-file publication. */
const checkParent = async (
  root: string,
  expected: Directory,
  io: Io,
  signal: AbortSignal | undefined
): Promise<void> => {
  signal?.throwIfAborted()
  const real = await io.realpath(expected.path)
  const stats = await io.lstat(real)
  if (
    !SafeFs.inside(root, real) ||
    real !== expected.path ||
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    identity(stats) !== identity(expected.stats)
  ) {
    throw new Error(`projection parent changed while a file was being published: ${expected.path}`)
  }
}

interface Temporary {
  readonly file: WriteFile
  readonly path: string
}

const openTemporary = async (
  directory: string,
  base: string,
  mode: number,
  io: Io,
  signal: AbortSignal | undefined
): Promise<Temporary> => {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    signal?.throwIfAborted()
    const path = NodePath.join(directory, `.${base}.${process.pid.toString(36)}.${randomUUID()}.tmp`)
    try {
      return { file: await io.create(path, mode), path }
    } catch (cause) {
      if (SafeFs.errorCode(cause) !== "EEXIST") throw cause
    }
  }
  throw new Error(`could not create a unique projection temporary in ${directory}`)
}

/** Validates one read result before it reaches a slice or a counter. */
const checkedRead = async (handle: SafeFs.OpenFile, buffer: Uint8Array, what: string): Promise<number> => {
  const bytesRead = await handle.read(buffer)
  if (!Number.isInteger(bytesRead) || bytesRead < 0 || bytesRead > buffer.byteLength) {
    throw new Error(
      `${what} returned an invalid read length: ${typeof bytesRead === "number" ? String(bytesRead) : typeof bytesRead}`
    )
  }
  return bytesRead
}

interface Copied {
  readonly bytes: bigint
  readonly digest: string
}

/**
 * Streams one open source into a sibling temporary and renames it into place.
 */
const publish = async (
  handle: SafeFs.OpenFile,
  before: SafeFs.Stats,
  root: string,
  parent: Directory,
  absolute: string,
  mode: number,
  io: Io,
  signal: AbortSignal | undefined,
  what: string
): Promise<Copied> => {
  const temporary = await openTemporary(parent.path, NodePath.basename(absolute), mode, io, signal)
  let consumed = false
  let primary: unknown
  let copied: Copied | undefined
  try {
    const opened = await temporary.file.stat()
    const named = await io.lstat(temporary.path)
    const real = await io.realpath(temporary.path)
    if (
      !opened.isFile() ||
      linksOf(opened) !== 1n ||
      identity(opened) !== identity(named) ||
      !SafeFs.inside(root, real)
    ) {
      throw new Error("projection temporary did not remain a private file")
    }
    const buffer = new Uint8Array(SafeFs.chunkBytes)
    const hash = createHash("sha256")
    let total = 0n
    while (true) {
      signal?.throwIfAborted()
      const bytesRead = await checkedRead(handle, buffer, what)
      if (bytesRead === 0) break
      const chunk = buffer.subarray(0, bytesRead)
      hash.update(chunk)
      await temporary.file.write(chunk)
      total += BigInt(bytesRead)
    }
    const after = await handle.stat()
    if (!stable(before, after, total)) {
      throw new Error(`${what} changed while it was being copied: ${absolute}`)
    }
    const written = await temporary.file.stat()
    if (!written.isFile() || linksOf(written) !== 1n || sizeOf(written) !== total) {
      throw new Error("projection temporary did not receive the complete file")
    }
    await temporary.file.sync()
    copied = { bytes: total, digest: hash.digest("hex") }
  } catch (cause) {
    primary = cause
  }
  try {
    await temporary.file.close()
  } catch (cause) {
    primary ??= cause
  }
  if (primary === undefined) {
    try {
      await checkParent(root, parent, io, signal)
      await io.rename(temporary.path, absolute)
      consumed = true
      await io.syncDirectory(parent.path)
    } catch (cause) {
      primary = cause
    }
  }
  if (!consumed) {
    try {
      await io.remove(temporary.path)
    } catch (cause) {
      primary ??= cause
    }
  }
  if (primary !== undefined) throw primary
  return copied as Copied
}

/**
 * Opens one admitted file, re-checks it through its own descriptor, and copies
 * it.
 *
 * The descriptor decides every question the admitting `lstat` answered: it has
 * to be a regular file, the same object, the same size and timestamps, and it
 * has to still resolve inside the source root. A name that was pointed at
 * something else between admission and open therefore fails rather than
 * putting another file's bytes under the declared path.
 */
const copyAdmitted = async (
  entry: SafeFs.Entry,
  sourceRoot: string,
  destinationRoot: string,
  parent: Directory,
  absolute: string,
  existing: SafeFs.Stats | undefined,
  privateCopy: boolean,
  io: Io,
  signal: AbortSignal | undefined,
  what: string
): Promise<Copied> => {
  signal?.throwIfAborted()
  let handle: SafeFs.OpenFile
  try {
    handle = await io.open(entry.path)
  } catch (cause) {
    if (SafeFs.errorCode(cause) === "ELOOP") {
      throw new Error(`${what} became a symbolic link while it was being opened: ${entry.path}`)
    }
    throw cause
  }
  let primary: unknown
  let copied: Copied | undefined
  try {
    const before = await handle.stat()
    if (!before.isFile()) throw new Error(`${what} is not a regular file: ${entry.path}`)
    if (identity(before) !== identity(entry.stats)) {
      throw new Error(`${what} was replaced while it was being opened: ${entry.path}`)
    }
    if (
      sizeOf(before) !== sizeOf(entry.stats) ||
      timestamp(before, "mtime") !== timestamp(entry.stats, "mtime") ||
      timestamp(before, "ctime") !== timestamp(entry.stats, "ctime")
    ) {
      throw new Error(`${what} changed while it was being opened: ${entry.path}`)
    }
    const resolved = await io.realpath(entry.path)
    if (!SafeFs.inside(sourceRoot, resolved)) {
      throw new Error(`${what} left its root while it was being opened: ${entry.path}`)
    }
    const current = await io.lstat(resolved)
    if (identity(current) !== identity(before)) {
      throw new Error(`${what} was replaced while its open descriptor was being confined: ${entry.path}`)
    }
    copied = await publish(
      handle,
      before,
      destinationRoot,
      parent,
      absolute,
      modeFor(before, existing, privateCopy),
      io,
      signal,
      what
    )
  } catch (cause) {
    primary = cause
  }
  try {
    await handle.close()
  } catch (cause) {
    primary ??= new Error(`${what} could not be closed: ${entry.path}: ${failureMessage(cause)}`)
  }
  if (primary !== undefined) throw primary
  return copied as Copied
}

/** Resolves and orders one declared path set, refusing a path no transfer may carry. */
const declaredPaths = (paths: ReadonlyArray<string>): ReadonlyArray<string> => {
  if (paths.length > maximumProjectedFiles) {
    throw new Error(`a projection carries at most ${maximumProjectedFiles} files, received ${paths.length}`)
  }
  const resolved = new Set<string>()
  for (const path of paths) resolved.add(resolveProjectedPath(path))
  // Sorted, so two hosts copy the same set in the same order and a transfer
  // that fails halfway fails at the same file on both.
  return [...resolved].sort()
}

/**
 * Copies one declared set from one confined root to another.
 *
 * `replace` decides what an existing destination file means. Seeding a scratch
 * root refuses one, because a scratch root holds exactly what this transfer
 * put there and a collision means two transfers are writing the same tree.
 * Copying back into a workspace replaces one, because replacing the previous
 * output is the operation.
 */
const transfer = async (
  fromRoot: string,
  toRoot: string,
  paths: ReadonlyArray<string>,
  options: Options,
  what: string,
  replace: boolean
): Promise<Projection> => {
  const io = options.io ?? defaultIo
  const signal = options.signal
  const declared = declaredPaths(paths)
  signal?.throwIfAborted()
  const from = await SafeFs.canonicalRoot(fromRoot, io)
  const to = await SafeFs.canonicalRoot(toRoot, io)
  if (from === to) {
    throw new Error(`a projection source and destination must be different directories: ${from}`)
  }
  const files: Array<ProjectedFile> = []
  const absent: Array<string> = []
  for (const path of declared) {
    signal?.throwIfAborted()
    const entry = await SafeFs.resolveFile(NodePath.join(from, path), {
      root: from,
      io,
      what,
      signal,
      symlinks: "reject"
    })
    if (entry === undefined) {
      absent.push(path)
      continue
    }
    const parent = await prepareParent(to, path, io, signal)
    const absolute = NodePath.join(parent.path, NodePath.basename(path))
    let existing: SafeFs.Stats | undefined
    try {
      existing = await io.lstat(absolute)
    } catch (cause) {
      if (SafeFs.errorCode(cause) !== "ENOENT") throw cause
    }
    if (existing !== undefined) {
      if (!replace) throw new Error(`${what} is already present at its destination: ${path}`)
      if (existing.isSymbolicLink()) throw new Error(`${what} destination is a symbolic link: ${path}`)
      if (!existing.isFile()) throw new Error(`${what} destination is not a regular file: ${path}`)
    }
    const copied = await copyAdmitted(entry, from, to, parent, absolute, existing, !replace, io, signal, what)
    files.push({ path, bytes: Number(copied.bytes), digest: copied.digest })
  }
  return { from, to, files, absent }
}

/**
 * Materializes exactly the declared files under a scratch root.
 *
 * `files` are workspace-relative paths. Each one is admitted against the
 * canonical workspace root, copied to the same relative location under the
 * canonical scratch root, and reported with the digest of the bytes that
 * moved. A declared path that names nothing is reported in `absent`; every
 * other refusal throws, because a path that resolves outside the workspace, a
 * symbolic link, or a file that changed mid-copy is a broken declaration
 * rather than an empty one.
 *
 * The scratch root must already exist, and each destination file must not: a
 * projection seeds a tree, it does not merge into one.
 *
 * @category execution
 * @since 0.1.0
 */
export const project = (
  workspaceRoot: string,
  scratchRoot: string,
  files: ReadonlyArray<string>,
  options: Options = {}
): Promise<Projection> => transfer(workspaceRoot, scratchRoot, files, options, "declared input", false)

/**
 * Copies the declared outputs from a scratch root back into the workspace.
 *
 * The reverse of {@link project}, under the same confinement, with one
 * difference: an output replaces the workspace file it names, keeping that
 * file's mode, because replacing the previous output is the operation. A
 * declared output the body never produced is reported in `absent` rather than
 * failing here, so the caller can decide whether a missing output fails the
 * target.
 *
 * @category execution
 * @since 0.1.0
 */
export const collect = (
  scratchRoot: string,
  workspaceRoot: string,
  outputs: ReadonlyArray<string>,
  options: Options = {}
): Promise<Projection> => transfer(scratchRoot, workspaceRoot, outputs, options, "declared output", true)

/**
 * {@link project} as an Effect.
 *
 * @category effects
 * @since 0.1.0
 */
export const projectInputs = (
  workspaceRoot: string,
  scratchRoot: string,
  files: ReadonlyArray<string>
): Effect.Effect<Projection, ProjectionError> =>
  Effect.tryPromise({
    try: (signal) => project(workspaceRoot, scratchRoot, files, { signal }),
    catch: (cause) => new ProjectionError({ root: scratchRoot, message: failureMessage(cause) })
  })

/**
 * {@link collect} as an Effect.
 *
 * @category effects
 * @since 0.1.0
 */
export const collectOutputs = (
  scratchRoot: string,
  workspaceRoot: string,
  outputs: ReadonlyArray<string>
): Effect.Effect<Projection, ProjectionError> =>
  Effect.tryPromise({
    try: (signal) => collect(scratchRoot, workspaceRoot, outputs, { signal }),
    catch: (cause) => new ProjectionError({ root: workspaceRoot, message: failureMessage(cause) })
  })
