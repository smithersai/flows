/**
 * Read-through result cache: a content-addressed local file store fronting an
 * optional HTTP remote.
 *
 * The local store answers reads first. A remote lookup runs only on a local
 * miss, and a remote hit hydrates the local file so the next read stays on
 * disk. A put writes both stores. Any remote failure prints one warning line
 * and degrades the store to local-only for the rest of the process.
 *
 * Every read on both sides is an untrusted read. A local entry file may have
 * been replaced by a symbolic link, a FIFO, or four gigabytes of noise; a
 * remote body may never end. Both are bounded and type-checked before anything
 * is parsed, and both degrade to a miss rather than to a hazard.
 *
 * @since 0.1.0
 */
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { createHash, randomUUID } from "node:crypto"
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"
import * as Config from "tsflows-rules/Config"

/**
 * One stored rule execution result.
 *
 * @category models
 * @since 0.1.0
 */
export interface CachedResult {
  key: string
  rule: string
  label: string
  exitOk: boolean
  output: unknown
  storedAt: string
}

/**
 * The cache handle the engine reads and writes through.
 *
 * @category models
 * @since 0.1.0
 */
export interface CacheStore {
  get(key: string): Promise<CachedResult | null>
  put(key: string, r: CachedResult): Promise<void>
  close(): Promise<void>
}

/**
 * The largest entry either store will read.
 *
 * An entry is one action's success value. Sixteen mebibytes is far above any
 * legitimate one and far below a size that threatens the process, so a store
 * that has been filled with a huge file answers a miss instead of turning a
 * cache lookup into an out-of-memory failure.
 *
 * @category constants
 * @since 0.1.0
 */
export const entryLimit = 16 * 1024 * 1024

/**
 * The default deadline for one remote request, including its whole body.
 *
 * @category constants
 * @since 0.1.0
 */
export const remoteTimeouts = { get: 3_000, put: 8_000 } as const

/**
 * The stored entry shape both stores decode through.
 *
 * `key`, `rule`, and `label` are required to be non-empty: an entry that
 * cannot name the action it came from cannot be trusted to answer for one.
 * `exitOk` must be a real boolean, so a truthy-looking value never admits a
 * failed run as a hit.
 */
const StoredResult = Schema.Struct({
  key: Schema.NonEmptyString,
  rule: Schema.NonEmptyString,
  label: Schema.NonEmptyString,
  exitOk: Schema.Boolean,
  output: Schema.Unknown,
  storedAt: Schema.NonEmptyString
})

const decodeStored = Schema.decodeUnknownOption(StoredResult)

/**
 * Decodes one candidate entry and requires it to answer for `key`.
 *
 * Both stores share this boundary. A well-formed entry filed under the wrong
 * key is a corrupt store, not a hit: returning it would answer one action with
 * another action's result, which is the one failure mode a content-addressed
 * cache must never have. The executor checks the entry's rule and label on top
 * of this, so a store that reuses one key for two actions is caught there too.
 */
const decodeFor = (key: string, candidate: unknown): CachedResult | null => {
  const decoded = decodeStored(candidate)
  if (Option.isNone(decoded) || decoded.value.key !== key) return null
  return decoded.value
}

const wellFormedKey = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/

/**
 * Maps a cache key onto a name that is safe as a single path segment.
 *
 * A key that starts with a letter or digit, uses only letters, digits, dots,
 * underscores, and dashes, and is at most 200 characters long passes through
 * unchanged. Every other key becomes the lowercase hex SHA-256 of its UTF-16
 * code units. UTF-16 is deliberate: UTF-8 encoding replaces an unpaired
 * surrogate, which let two distinct JavaScript strings map to one file name.
 * Hashing the code units is injective up to SHA-256 and keeps the file name
 * inside the cache directory.
 *
 * @category utilities
 * @since 0.1.0
 */
export const sanitizeKey = (key: string): string =>
  wellFormedKey.test(key) ? key : createHash("sha256").update(Buffer.from(key, "utf16le")).digest("hex")

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined

const failureMessage = (cause: unknown): string =>
  cause instanceof Error && cause.message !== "" ? cause.message : String(cause)

/** Reports whether `candidate` is `root` or below it, lexically. */
const inside = (root: string, candidate: string): boolean => {
  const relative = NodePath.relative(root, candidate)
  return relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${NodePath.sep}`) && !NodePath.isAbsolute(relative))
}

/**
 * Resolves a directory that must stay inside the workspace once symbolic links
 * are followed, or throws.
 *
 * `Config.normalizeCacheDirectory` already refuses an absolute path and any
 * `..` segment, which settles the lexical question. It cannot settle the
 * filesystem question: `.flows` may itself be a symbolic link to somewhere
 * else entirely, and every entry the cache published would then land outside
 * the workspace, writing files wherever the link points. A missing directory
 * is fine — it is created and validated again — but an existing one that
 * resolves out of the workspace fails the command.
 *
 * ## Boundary
 *
 * Validation resolves the path that exists at the moment it runs. Node has no
 * portable descriptor-relative open (`openat` with `RESOLVE_BENEATH`), so an
 * ancestor directory replaced by an outside-pointing symbolic link between
 * this check and a later write is not detected. Closing that window needs
 * platform-specific syscalls Node does not expose; what is closed here is the
 * durable case, a workspace whose cache directory is a link.
 */
const confineDirectory = async (
  boundary: string,
  directory: string,
  what = "cache directory"
): Promise<void> => {
  const resolved = await Fs.realpath(directory).catch((cause: unknown) => {
    if (errorCode(cause) === "ENOENT") return undefined
    throw cause
  })
  if (resolved !== undefined && !inside(boundary, resolved)) {
    throw new Error(
      what === "cache directory"
        ? `cache directory leaves the workspace: ${directory} resolves to ${resolved}`
        : `${what} leaves its allowed root: ${directory} resolves to ${resolved}`
    )
  }
}

/**
 * Creates the cache directory and refuses one that escapes the workspace.
 *
 * The check runs before the directory is created, so an existing link is
 * caught, and again afterwards, so a link created concurrently with the
 * `mkdir` is caught too.
 *
 * @category validation
 * @since 0.1.0
 */
export const ensureCacheDirectory = async (
  workspaceRoot: string,
  cacheDirectory: string
): Promise<string> => {
  const root = await Fs.realpath(workspaceRoot)
  const segments = [...Config.normalizeCacheDirectory(cacheDirectory).split("/"), "cache"]
  // Every ancestor is checked, and checked before anything is created: a
  // `.flows` that already points outside must fail the command rather than
  // have a `cache` directory created out there first.
  let directory = root
  for (const segment of segments) {
    directory = NodePath.join(directory, segment)
    await confineDirectory(root, directory)
  }
  await Fs.mkdir(directory, { recursive: true })
  await confineDirectory(root, directory)
  return Fs.realpath(directory)
}

const localPath = (cacheRoot: string, key: string): string => {
  const safe = sanitizeKey(key)
  return NodePath.join(cacheRoot, safe.slice(0, 2), `${safe}.json`)
}

/**
 * Returns an open(2) flag the platform may not provide. Windows builds of
 * libuv define neither `O_NOFOLLOW` nor `O_NONBLOCK`; a missing flag
 * contributes nothing rather than crashing the open.
 */
const optionalOpenFlag = (name: "O_NOFOLLOW" | "O_NONBLOCK"): number =>
  (NodeFs.constants as Partial<Record<string, number>>)[name] ?? 0

/**
 * Reads one entry file as JSON, or null when it is absent, not a plain file,
 * too large, or not JSON.
 *
 * The whole read is defensive, because the file is untrusted input even in a
 * private workspace: a shared cache directory, a restored backup, or a hand
 * edit can put anything at the path.
 *
 * - `lstat` refuses a symbolic link, a FIFO, a device, a socket, and a
 *   directory before anything is opened, so a link planted at an entry path
 *   cannot make the cache read a file elsewhere.
 * - The open adds `O_NOFOLLOW` (never follow a link swapped in after the
 *   `lstat`) and `O_NONBLOCK` (a FIFO cannot block the open) where the platform
 *   provides them, so a hostile entry cannot stall the run.
 * - The descriptor is `fstat`-checked to be the same regular file the `lstat`
 *   saw, comparing device and inode, before a byte is read.
 * - The size is checked against {@link entryLimit} on the descriptor, so the
 *   bytes are never materialized before the limit is applied.
 *
 * Every failure is a miss. A cache is an optimization; it never gets to fail a
 * run, and it never gets to consume unbounded memory.
 */
const readEntryFile = async (path: string): Promise<unknown> => {
  let text: string | undefined
  // A concurrent writer publishes by renaming a new file onto this path, which
  // loses the identity check against a file that no longer exists. That is a
  // race, not a refusal, and retrying reads the newly published entry. Every
  // writer of one key writes the same bytes, so a retry cannot widen what is
  // accepted. A genuine refusal — a link, a FIFO, a directory, an oversize
  // file — returns immediately without retrying.
  for (let attempt = 0; attempt < 3 && text === undefined; attempt += 1) {
    let expected: NodeFs.BigIntStats
    try {
      expected = await Fs.lstat(path, { bigint: true })
    } catch {
      return null
    }
    if (!expected.isFile() || expected.size > BigInt(entryLimit) || expected.nlink !== 1n) return null
    let handle: Fs.FileHandle
    try {
      handle = await Fs.open(
        path,
        NodeFs.constants.O_RDONLY | optionalOpenFlag("O_NOFOLLOW") | optionalOpenFlag("O_NONBLOCK")
      )
    } catch {
      return null
    }
    let candidate: string | undefined
    try {
      const opened = await handle.stat({ bigint: true })
      if (
        opened.isFile() &&
        opened.dev === expected.dev &&
        opened.ino === expected.ino &&
        opened.nlink === 1n &&
        opened.size === expected.size &&
        opened.size <= BigInt(entryLimit) &&
        opened.mtimeNs === expected.mtimeNs &&
        opened.ctimeNs === expected.ctimeNs
      ) {
        // One byte of slack detects growth after the descriptor stat without
        // ever allocating more than the advertised entry ceiling.
        const buffer = Buffer.allocUnsafe(Number(opened.size) + 1)
        let total = 0
        while (total < buffer.length) {
          const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total)
          if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > buffer.length - total) {
            throw new Error(`cache entry returned an invalid read length: ${String(bytesRead)}`)
          }
          if (bytesRead === 0) break
          total += bytesRead
        }
        const after = await handle.stat({ bigint: true })
        if (
          after.isFile() &&
          after.dev === opened.dev &&
          after.ino === opened.ino &&
          after.nlink === opened.nlink &&
          after.size === opened.size &&
          after.mtimeNs === opened.mtimeNs &&
          after.ctimeNs === opened.ctimeNs &&
          BigInt(total) === opened.size
        ) {
          candidate = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, total))
        }
      }
    } catch {
      candidate = undefined
    }
    try {
      await handle.close()
    } catch {
      candidate = undefined
    }
    text = candidate
  }
  if (text === undefined) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

const readLocal = async (cacheRoot: string, key: string): Promise<CachedResult | null> => {
  const path = localPath(cacheRoot, key)
  await confineDirectory(cacheRoot, NodePath.dirname(path), "cache shard directory")
  return decodeFor(key, await readEntryFile(path))
}

/**
 * Fault-injection seams for the local store. Production callers omit this and
 * get the real filesystem. Tests substitute individual operations to reproduce
 * failures a real filesystem cannot produce deterministically — a directory
 * that refuses fsync, a close that fails, a temp file that cannot be removed.
 * Injection replaces which operation runs, never what the store does with its
 * result, so the tested policy is the production policy.
 *
 * @category models
 * @since 0.1.0
 */
export interface CacheIo {
  readonly rename?: (from: string, to: string) => Promise<void>
  readonly writeContents?: (handle: Fs.FileHandle, contents: string) => Promise<void>
  readonly openDirectory?: (directory: string) => Promise<Fs.FileHandle>
  readonly syncHandle?: (handle: Fs.FileHandle) => Promise<void>
  readonly closeHandle?: (handle: Fs.FileHandle) => Promise<void>
  readonly removeTemp?: (temp: string) => Promise<void>
}

const writeContentsLive = (handle: Fs.FileHandle, contents: string): Promise<void> => handle.writeFile(contents, "utf8")
const openDirectoryLive = (directory: string): Promise<Fs.FileHandle> => Fs.open(directory, "r")
const syncHandleLive = (handle: Fs.FileHandle): Promise<void> => handle.sync()
const closeHandleLive = (handle: Fs.FileHandle): Promise<void> => handle.close()
const removeTempLive = (temp: string): Promise<void> => Fs.rm(temp, { force: true })

/**
 * Creates a sibling temporary file nobody else can be holding.
 *
 * The name is unique by construction and the handle is opened with exclusive
 * create, so two writers of the same entry can never share a temp file and a
 * stale temp left by a crashed process is never adopted. Bazel's
 * `DiskCacheClient.saveFile` takes the same position with a per-write UUID.
 *
 * The mode is left to the default so the published entry keeps the permissions
 * the umask asks for. A cache directory shared between accounts stays readable.
 */
const createTemp = async (
  directory: string,
  base: string
): Promise<{ readonly handle: Fs.FileHandle; readonly temp: string }> => {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const temp = NodePath.join(directory, `.${base}.${process.pid.toString(36)}.${randomUUID()}.tmp`)
    try {
      return { handle: await Fs.open(temp, "wx"), temp }
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error
    }
  }
  throw new Error(`could not create a unique temporary file in ${directory}`)
}

/**
 * Error codes that mean the filesystem refuses fsync on a directory descriptor
 * it did hand out. Permission errors, bad descriptors, and anything unknown are
 * real I/O failures and propagate.
 */
const directorySyncUnsupported = new Set(["ENOTSUP", "EOPNOTSUPP", "EINVAL", "ENOSYS"])

/**
 * Flushes the directory entry created by the rename.
 *
 * POSIX needs this for the rename itself to survive a machine crash. Windows
 * exposes no portable directory descriptor through Node, so the barrier is
 * skipped there deliberately rather than attempted and swallowed.
 *
 * Everything else is real I/O. Opening the directory is an ordinary open and
 * its failures propagate; only the narrow fsync codes that mean "this
 * filesystem does not implement directory sync" are tolerated. The handle is
 * closed exactly once and a close failure propagates unless a sync failure is
 * already propagating, in which case the sync failure is the one reported.
 */
const syncDirectory = async (
  directory: string,
  openDirectory: (directory: string) => Promise<Fs.FileHandle>,
  syncHandle: (handle: Fs.FileHandle) => Promise<void>,
  closeHandle: (handle: Fs.FileHandle) => Promise<void>
): Promise<void> => {
  if (process.platform === "win32") return
  const handle = await openDirectory(directory)
  let primary: { readonly cause: unknown } | undefined
  try {
    await syncHandle(handle)
  } catch (cause) {
    if (!directorySyncUnsupported.has(errorCode(cause) ?? "")) primary = { cause }
  }
  try {
    await closeHandle(handle)
  } catch (cause) {
    primary ??= { cause }
  }
  if (primary !== undefined) throw primary.cause
}

/**
 * Renames the finished temp onto the entry path, tolerating a concurrent
 * writer that already published the same entry.
 *
 * POSIX rename is atomic and replaces the destination, so a concurrent
 * complete writer is invisible. Windows refuses a rename onto a destination
 * another process has open; entries are content addressed and every writer of
 * one key writes the same bytes, so an existing destination that decodes for
 * the key is an acceptable outcome rather than a failure. This mirrors Bazel's
 * `renameToleratingConcurrentCreation` and the Windows branch of
 * `VirtualActionInput.atomicallyWriteTo`.
 *
 * Returns true when the rename consumed the temp file.
 */
const renameTolerantly = async (
  temp: string,
  path: string,
  key: string,
  rename: (from: string, to: string) => Promise<void>
): Promise<boolean> => {
  try {
    await rename(temp, path)
    return true
  } catch (error) {
    const code = errorCode(error)
    if (
      process.platform === "win32" &&
      (code === "EPERM" || code === "EACCES" || code === "EBUSY") &&
      decodeFor(key, await readEntryFile(path)) !== null
    ) return false
    throw error
  }
}

/**
 * Publishes one entry atomically.
 *
 * The bytes go to an exclusively created sibling temp file that is written,
 * fsynced, and closed before it is renamed onto the entry path, so a reader
 * observes either no entry or the whole entry. Failure discipline mirrors the
 * generated-file writer:
 *
 * - A close failure never publishes as success. When an earlier failure exists
 *   the close still runs and the earlier failure is the one reported.
 * - Temp removal is attempted on every path that did not consume the temp, and
 *   never masks a primary failure. A removal that fails after an otherwise
 *   successful publication is reported, because the alternative is claiming a
 *   clean success while leaking one file per concurrent writer.
 * - The containing directory is fsynced last, and its failures are real.
 */
const writeLocal = async (
  cacheRoot: string,
  key: string,
  result: CachedResult,
  io: CacheIo
): Promise<void> => {
  if (result.key !== key) {
    throw new TypeError(`refusing to store an entry keyed ${result.key} under ${key}`)
  }
  const rename = io.rename ?? Fs.rename
  const writeContents = io.writeContents ?? writeContentsLive
  const openDirectory = io.openDirectory ?? openDirectoryLive
  const syncHandle = io.syncHandle ?? syncHandleLive
  const closeHandle = io.closeHandle ?? closeHandleLive
  const removeTemp = io.removeTemp ?? removeTempLive
  const path = localPath(cacheRoot, key)
  const directory = NodePath.dirname(path)
  const stored: CachedResult = { ...result, output: result.output === undefined ? null : result.output }
  const text = JSON.stringify(stored)
  const bytes = Buffer.byteLength(text, "utf8")
  if (bytes > entryLimit) {
    throw new RangeError(`cache entry is ${bytes} bytes, exceeding its limit of ${entryLimit}`)
  }
  await Fs.mkdir(directory, { recursive: true })
  // The shard directory is created here, so it is validated here: a cache
  // directory swapped for an outside link between open and put must not
  // publish outside the workspace.
  await confineDirectory(cacheRoot, directory, "cache shard directory")
  const { handle, temp } = await createTemp(directory, NodePath.basename(path))
  let tempConsumed = false
  let primary: { readonly cause: unknown } | undefined
  try {
    await writeContents(handle, text)
    await syncHandle(handle)
  } catch (cause) {
    primary = { cause }
  }
  try {
    await closeHandle(handle)
  } catch (cause) {
    primary ??= { cause }
  }
  if (primary === undefined) {
    try {
      tempConsumed = await renameTolerantly(temp, path, key, rename)
    } catch (cause) {
      primary = { cause }
    }
  }
  if (!tempConsumed) {
    try {
      await removeTemp(temp)
    } catch (cause) {
      primary ??= {
        cause: new Error(
          `the entry was published but the temporary file ${temp} could not be removed: ${failureMessage(cause)}`
        )
      }
    }
  }
  if (primary !== undefined) throw primary.cause
  await syncDirectory(directory, openDirectory, syncHandle, closeHandle)
}

/**
 * Bounds one asynchronous operation with a real deadline.
 *
 * Aborting the signal is a request, not a guarantee: a custom `fetch`, a
 * polyfill, or a body that never ends is free to ignore it, and the previous
 * implementation then waited forever with a timer that had already fired. The
 * deadline is therefore a race the timer can win on its own. The signal is
 * still aborted so a cooperating implementation releases its socket, and the
 * losing promise's rejection is absorbed so an abort that arrives after the
 * race never surfaces as an unhandled rejection.
 */
const withDeadline = async <A>(
  operation: "get" | "put",
  milliseconds: number,
  run: (signal: AbortSignal) => Promise<A>
): Promise<A> => {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const cause = new Error(`remote cache ${operation} timed out after ${milliseconds}ms`)
      controller.abort(cause)
      reject(cause)
    }, milliseconds)
  })
  const running = Promise.resolve().then(() => run(controller.signal))
  running.catch(() => undefined)
  try {
    return await Promise.race([running, expiry])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Reads a response body with a hard byte ceiling.
 *
 * `Content-Length` is checked first when the server declares one, so an
 * oversize body is refused before a byte is transferred. It is only a hint,
 * and a chunked or streaming body declares nothing at all, so the stream is
 * also read incrementally and abandoned the moment the accumulated length
 * passes the limit. `response.text()` and `response.json()` have neither
 * property: both buffer whatever arrives.
 */
const readBoundedBody = async (response: Response, limit: number): Promise<string | undefined> => {
  const declared = response.headers.get("content-length")
  let declaredLength: number | undefined
  if (declared !== null) {
    const length = Number(declared)
    if (!/^\d+$/.test(declared) || !Number.isSafeInteger(length) || length > limit) {
      await response.body?.cancel().catch(() => undefined)
      return undefined
    }
    declaredLength = length
  }
  const body = response.body
  if (body === null) return ""
  const reader = body.getReader()
  let bytes = Buffer.allocUnsafe(Math.min(limit, Math.max(1024, declaredLength ?? 64 * 1024)))
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      total += value.byteLength
      if (total > limit) {
        await reader.cancel().catch(() => undefined)
        return undefined
      }
      if (total > bytes.byteLength) {
        let capacity = bytes.byteLength
        while (capacity < total) capacity = Math.min(limit, Math.max(capacity * 2, total))
        const grown = Buffer.allocUnsafe(capacity)
        bytes.copy(grown, 0, 0, total - value.byteLength)
        bytes = grown
      }
      Buffer.from(value.buffer, value.byteOffset, value.byteLength).copy(bytes, total - value.byteLength)
    }
  } finally {
    reader.releaseLock()
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, total))
  } catch {
    return undefined
  }
}

const maximumRemoteTimeoutMs = 5 * 60 * 1000

/** Validates programmatic deadline overrides before a timer or filesystem mutation. */
const validateTimeouts = (
  value: { readonly get: number; readonly put: number } | undefined
): { readonly get: number; readonly put: number } => {
  const timeouts = value ?? remoteTimeouts
  for (const operation of ["get", "put"] as const) {
    const milliseconds = timeouts[operation]
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > maximumRemoteTimeoutMs) {
      throw new TypeError(
        `remote cache ${operation} timeout must be an integer from 1 to ${maximumRemoteTimeoutMs}, ` +
          `received ${String(milliseconds)}`
      )
    }
  }
  return { get: timeouts.get, put: timeouts.put }
}

/** What one bounded remote GET settled on, inside its deadline. */
type Fetched =
  | { readonly _tag: "miss" }
  | { readonly _tag: "degrade"; readonly status?: number | undefined }
  | { readonly _tag: "entry"; readonly result: CachedResult }

class RemoteStore {
  private readonly endpoint: string
  private readonly token: string | undefined
  private readonly fetch: typeof globalThis.fetch
  private readonly warn: (line: string) => void
  private readonly timeouts: { readonly get: number; readonly put: number }
  private degraded = false
  private conflictWarned = false

  constructor(options: {
    readonly endpoint: string
    readonly token?: string | undefined
    readonly fetch: typeof globalThis.fetch
    readonly warn: (line: string) => void
    readonly timeouts: { readonly get: number; readonly put: number }
  }) {
    this.endpoint = options.endpoint.replace(/\/+$/, "")
    this.token = options.token
    this.fetch = options.fetch
    this.warn = options.warn
    this.timeouts = options.timeouts
  }

  private degrade(operation: "GET" | "PUT", status?: number | undefined): void {
    if (this.degraded) return
    this.degraded = true
    this.warn(
      `tsflows: remote cache disabled after a failure: ${operation}` +
        (status === undefined ? " request failed" : ` returned HTTP ${status}`)
    )
  }

  private url(key: string): string {
    return `${this.endpoint}/ac/${encodeURIComponent(key)}`
  }

  private headers(): Headers {
    const headers = new Headers({ "content-type": "application/json" })
    if (this.token !== undefined && this.token !== "") {
      headers.set("authorization", `Bearer ${this.token}`)
    }
    return headers
  }

  async get(key: string): Promise<CachedResult | null> {
    if (this.degraded) return null
    let fetched: Fetched
    try {
      // The whole exchange runs inside one deadline: the request, the body,
      // and the parse. Reading the body outside it left a hung response able
      // to stall the run after the request itself had already come back.
      fetched = await withDeadline(
        "get",
        this.timeouts.get,
        async (signal): Promise<Fetched> => {
          const response = await this.fetch(this.url(key), {
            method: "GET",
            headers: this.headers(),
            redirect: "error",
            signal
          })
          if (response.status === 404) {
            await response.body?.cancel().catch(() => undefined)
            return { _tag: "miss" }
          }
          if (response.status !== 200) {
            await response.body?.cancel().catch(() => undefined)
            return { _tag: "degrade", status: response.status }
          }
          const text = await readBoundedBody(response, entryLimit)
          if (text === undefined) return { _tag: "degrade" }
          let value: unknown
          try {
            value = JSON.parse(text) as unknown
          } catch {
            return { _tag: "degrade" }
          }
          const candidate = typeof value === "object" && value !== null && "result" in value ? value.result : value
          const decoded = decodeFor(key, candidate)
          return decoded === null ? { _tag: "degrade" } : { _tag: "entry", result: decoded }
        }
      )
    } catch {
      this.degrade("GET")
      return null
    }
    if (fetched._tag === "entry") return fetched.result
    if (fetched._tag === "degrade") this.degrade("GET", fetched.status)
    return null
  }

  async put(key: string, result: CachedResult): Promise<void> {
    if (this.degraded) return
    try {
      const parsedStoredAt = Date.parse(result.storedAt)
      const body = JSON.stringify({
        keyDigest: key,
        result: { ...result, output: result.output === undefined ? null : result.output },
        meta: { rule: result.rule, label: result.label, exitOk: result.exitOk },
        createdAtMs: Number.isFinite(parsedStoredAt) ? parsedStoredAt : Date.now(),
        recordedRunId: `tsflows-cli:${result.label}`,
        recordedEventSeq: 0
      })
      if (Buffer.byteLength(body, "utf8") > entryLimit) {
        throw new RangeError(`remote cache request exceeds its ${entryLimit}-byte limit`)
      }
      const status = await withDeadline("put", this.timeouts.put, async (signal) => {
        const response = await this.fetch(this.url(key), {
          method: "PUT",
          headers: this.headers(),
          body,
          redirect: "error",
          signal
        })
        // Draining inside the deadline keeps a server that answers and then
        // holds the connection open from stalling the run.
        await response.body?.cancel().catch(() => undefined)
        return response.status
      })
      if (status === 200 || status === 201) return
      if (status === 409) {
        if (!this.conflictWarned) {
          this.conflictWarned = true
          this.warn("tsflows: remote cache conflict; keeping the first published result")
        }
        return
      }
      this.degrade("PUT", status)
    } catch {
      this.degrade("PUT")
    }
  }

  async close(): Promise<void> {}
}

/**
 * Opens the workspace cache.
 *
 * Local entries live under `<workspaceRoot>/<cacheDirectory>/cache` as JSON
 * files addressed by sanitized key and published atomically: an exclusively
 * created sibling temporary file is written, synced, and closed before it is
 * renamed onto the entry path, so a reader sees either no entry or the whole
 * entry. The cache directory must stay inside the workspace once symbolic
 * links resolve, checked when it is opened and again when an entry is written.
 * Every entry read from either store is bounded, type-checked, and must name
 * the requested key, so a truncated, oversize, forged, or misfiled entry is a
 * miss rather than another action's result. `cacheDirectory` is the
 * workspace-relative directory the CLI resolved and defaults to `.flows`. When
 * `endpoint` names an HTTP cache, the store also reads through its `/ac`
 * route: a local hit never touches the remote, a remote hit hydrates the local
 * file, and a put writes both sides.
 *
 * @category constructors
 * @since 0.1.0
 */
export const openCache = async (
  opts: {
    readonly workspaceRoot: string
    readonly cacheDirectory?: string | undefined
    readonly endpoint?: string | undefined
    readonly token?: string | undefined
    readonly fetch?: typeof globalThis.fetch | undefined
    readonly warn?: ((line: string) => void) | undefined
    readonly timeouts?: { readonly get: number; readonly put: number } | undefined
    readonly io?: CacheIo | undefined
  }
): Promise<CacheStore> => {
  const timeouts = validateTimeouts(opts.timeouts)
  const workspaceRoot = await Fs.realpath(NodePath.resolve(opts.workspaceRoot))
  const cacheRoot = await ensureCacheDirectory(
    workspaceRoot,
    opts.cacheDirectory ?? Config.defaultCacheDirectory
  )
  const io = opts.io ?? {}
  const endpoint = opts.endpoint?.trim()
  const remote = endpoint === undefined || endpoint === ""
    ? null
    : new RemoteStore({
      endpoint,
      token: opts.token,
      fetch: opts.fetch ?? globalThis.fetch,
      warn: opts.warn ?? ((line) => process.stderr.write(`${line}\n`)),
      timeouts
    })
  return {
    async get(key: string): Promise<CachedResult | null> {
      const local = await readLocal(cacheRoot, key)
      if (local !== null) return local
      if (remote === null) return null
      const fetched = await remote.get(key)
      if (fetched === null) return null
      await writeLocal(cacheRoot, key, fetched, io).catch(() => undefined)
      return fetched
    },
    async put(key: string, r: CachedResult): Promise<void> {
      await writeLocal(cacheRoot, key, r, io)
      if (remote !== null) await remote.put(key, r)
    },
    async close(): Promise<void> {
      if (remote !== null) await remote.close()
    }
  }
}
