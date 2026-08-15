/**
 * The package-manager seam.
 *
 * Installing dependencies has two distinct jobs.
 * Fetching populates a content-addressed store under `.flows/store`;
 * linking materializes one project's `node_modules` out of that store.
 * The first is determined by declared package-manager inputs and is therefore
 * cacheable and shareable. The second writes a local tree of hardlinks,
 * symlinks, or copies, so it is never restored from another machine.
 *
 * This module is the `Layer` that decides which manager performs those two
 * jobs. It holds no flow vocabulary: `Install.ts` declares the actions and the
 * flow, and provides them over whichever implementation a composition picks.
 * Selecting npm rather than pnpm is a layer swap, exactly as
 * `docs/specs/Specs/Object Model.md` requires of every host-facing service.
 *
 * Host access is Effect's own: `effect/unstable/process/ChildProcessSpawner`
 * for commands and `effect/FileSystem` for reads. The platform arrives as a
 * layer construction option rather than from `globalThis.process`, because
 * this module has to stay browser-bundleable even though the managers it
 * drives do not.
 *
 * @since 0.1.0
 */
import { Sha256 } from "@smthrs/crypto-next"
import * as Context from "effect/Context"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import type * as PlatformError from "effect/PlatformError"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

/**
 * Schema for the supported package managers.
 *
 * Yarn is named here and has no implementation in this module yet. The seam
 * carries it because the fetch/link split holds for Yarn too: classic Yarn
 * fetches into a mirror and links a tree, and Yarn PnP fetches into a zip
 * cache and links nothing at all. See DESIGN.md, "Yarn".
 *
 * @category models
 * @since 0.1.0
 */
export const Name = Schema.Literals(["npm", "pnpm", "bun", "yarn"])

/**
 * The supported package managers.
 *
 * @category models
 * @since 0.1.0
 */
export type Name = typeof Name.Type

/**
 * Schema for the host facts a manager's store artifacts can vary by.
 *
 * @category models
 * @since 0.1.0
 */
export const Platform = Schema.Struct({
  /** The operating system, spelled as Node spells it: `darwin`, `linux`. */
  os: Schema.NonEmptyString,
  /** The CPU architecture, spelled as Node spells it: `arm64`, `x64`. */
  arch: Schema.NonEmptyString,
  /** The C library flavour where one is distinguishable: `glibc`, `musl`. */
  libc: Schema.NullOr(Schema.NonEmptyString)
})

/**
 * The host facts a manager's store artifacts can vary by.
 *
 * @category models
 * @since 0.1.0
 */
export type Platform = typeof Platform.Type

/**
 * Schema for a content digest produced by this module.
 *
 * @category models
 * @since 0.1.0
 */
export const Digest = Sha256.Digest

/**
 * A content digest produced by this module.
 *
 * @category models
 * @since 0.1.0
 */
export type Digest = typeof Sha256.Digest.Type

/**
 * Schema for the stable error codes a manager operation reports.
 *
 * @category models
 * @since 0.1.0
 */
export const ErrorCode = Schema.Literals([
  "command_failed",
  "environment_mismatch",
  "lockfile_unreadable",
  "manifest_unreadable",
  "unsafe_configuration",
  "unsupported"
])

/**
 * The stable error codes a manager operation reports.
 *
 * @category models
 * @since 0.1.0
 */
export type ErrorCode = typeof ErrorCode.Type

/**
 * Error raised by a package-manager operation.
 *
 * The identity string is frozen: it is journaled and folded into recorded
 * results, so renaming it invalidates cached work.
 *
 * @category errors
 * @since 0.1.0
 */
export class PackageManagerError extends Schema.TaggedError<PackageManagerError>()(
  "tsflows/PackageManagerError",
  {
    code: ErrorCode,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown)
  }
) {}

/**
 * Schema for what a fetch produced: a description of the store population, and
 * never the bytes.
 *
 * The digest is machine-independent on purpose. It names the fetch's inputs,
 * not a host-specific store directory, so two machines that fetched the same
 * lockfile under the same manager agree on it and a shared cache entry means
 * the same thing on both. The fetch boundary records the store files as CAS
 * artifacts. A shared hit hydrates those files before link runs.
 *
 * @category models
 * @since 0.1.0
 */
export const StoreManifest = Schema.Struct({
  /** The manager whose store was populated. */
  manager: Name,
  /** The exact manager version that populated it. */
  managerVersion: Schema.NonEmptyString,
  /** The platform the store was populated for, or `null` when irrelevant. */
  platform: Schema.NullOr(Platform),
  /** The digest of the canonical manifest text. */
  digest: Digest
})

/**
 * What a fetch produced.
 *
 * @category models
 * @since 0.1.0
 */
export type StoreManifest = typeof StoreManifest.Type

/**
 * The workspace-relative root of every replayable package-manager store.
 *
 * Fetch writes beneath this path so the flows boundary can record the store
 * files in the existing artifact CAS. Link reads them locally and writes
 * `node_modules`, which is never published.
 *
 * @category constants
 * @since 0.1.0
 */
export const storeRoot = ".flows/store"

/**
 * Maximum bytes admitted from one project `.npmrc` file.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumNpmrcBytes = 256 * 1024
/**
 * Maximum bytes admitted from one project package manifest.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumPackageJsonBytes = 4 * 1024 * 1024
/**
 * Maximum bytes admitted from one package-manager lockfile.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumLockfileBytes = 64 * 1024 * 1024
/**
 * Maximum stdout bytes accepted from a package-manager version probe.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumVersionOutputBytes = 64 * 1024
/**
 * Default wall-clock timeout for one package-manager subprocess.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultCommandTimeoutMs = 30 * 60 * 1000
/**
 * Maximum configurable wall-clock timeout for one package-manager subprocess.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumCommandTimeoutMs = 24 * 60 * 60 * 1000

const maximumEnvironmentEntries = 4_096
const maximumEnvironmentBytes = 256 * 1024

/**
 * The two-verb contract every manager implements.
 *
 * @category models
 * @since 0.1.0
 */
export interface Service {
  /** Which manager this is. */
  readonly name: Name
  /** Absolute project root every filesystem read and child process is anchored to. */
  readonly projectRoot: string
  /** Workspace-relative store directory captured by the fetch boundary. */
  readonly storeDirectory: string
  /** The lockfile this manager reads, relative to the project root. */
  readonly lockfileName: string
  /**
   * Whether the set of artifacts a fetch downloads varies by host platform.
   *
   * True for every manager implemented here: optional dependencies resolve
   * per platform, so the fetched set does, even where the store's addressing
   * does not. A manager whose fetch is platform-independent sets this false
   * and drops the platform out of its key material.
   */
  readonly platformSensitive: boolean
  /** The host facts this layer was constructed for. */
  readonly platform: Platform
  /** The exact manager version, measured by running the manager. */
  readonly version: Effect.Effect<string, PackageManagerError>
  /**
   * Populates the content-addressed store from the lockfile alone, without
   * writing `node_modules`.
   */
  readonly fetch: Effect.Effect<void, PackageManagerError>
  /**
   * Materializes `node_modules` from the already-populated store, offline
   * where the manager supports it.
   */
  readonly link: Effect.Effect<void, PackageManagerError>
  /**
   * Digests the evidence this manager leaves behind describing the linked
   * tree. This is the node_modules manifest digest: never the tree itself.
   */
  readonly linkManifest: Effect.Effect<Digest, PackageManagerError, Crypto.Crypto>
}

/**
 * The package-manager service tag.
 *
 * @category services
 * @since 0.1.0
 */
export class PackageManager extends Context.Service<PackageManager, Service>()(
  "tsflows/PackageManager"
) {}

/**
 * Layer construction options shared by every implementation.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  /**
   * The absolute project root used as every manager command's cwd and every
   * package-manager file read's base. Keeping it in the service avoids any
   * process-wide `chdir`, so independent installs can run concurrently.
   */
  readonly projectRoot: string
  /**
   * The host facts to key platform-sensitive fetches by. It is an option
   * rather than a read of `globalThis.process` so this module never touches
   * the host outside a service call.
   */
  readonly platform: Platform
  /**
   * Host environment capability. Implementations select only process-startup
   * variables, network routing, and variables explicitly referenced by the
   * project `.npmrc`; the complete object is never inherited by a child.
   */
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined
  /** Wall-clock deadline for each fetch or link command. */
  readonly timeoutMs?: number | undefined
  /**
   * The manager executable, when it is not on `PATH` under its own name.
   */
  readonly executable?: string | undefined
}

/** @private */
const failedToStart = (label: string, cause: unknown): PackageManagerError =>
  new PackageManagerError({
    code: "command_failed",
    message: `${label} failed: ${failureMessage(cause)}`,
    cause
  })

/** @private */
const failedToRun = (label: string, code: number): PackageManagerError =>
  new PackageManagerError({
    code: "command_failed",
    message: `${label} exited with status ${code}`
  })

/** @private */
const failedToFinish = (label: string, timeoutMs: number): PackageManagerError =>
  new PackageManagerError({
    code: "command_failed",
    message: `${label} did not finish within ${timeoutMs}ms`
  })

/** @private */
const unreadable = (
  code: ErrorCode,
  path: string,
  cause: unknown
): PackageManagerError =>
  new PackageManagerError({ code, message: `could not read ${path}: ${failureMessage(cause)}`, cause })

/** @private */
const failureMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

const bootstrapEnvironment = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "PATH",
  "PATHEXT",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "WINDIR",
  "http_proxy",
  "https_proxy",
  "no_proxy"
] as const

const timeoutOf = (options: Options): number => {
  const timeout = options.timeoutMs ?? defaultCommandTimeoutMs
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > maximumCommandTimeoutMs) {
    throw new TypeError(
      `package-manager timeout must be an integer from 1 to ${maximumCommandTimeoutMs}, received ${String(timeout)}`
    )
  }
  return timeout
}

/** Reports whether UTF-8 encoding can preserve a string without replacement. */
const isWellFormedText = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length) return false
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) return false
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false
  }
  return true
}

const environmentSource = (
  options: Options
): ReadonlyMap<string, string> => {
  const entries = Object.entries(options.environment ?? {})
  if (entries.length > maximumEnvironmentEntries) {
    throw new TypeError(`package-manager environment has more than ${maximumEnvironmentEntries} entries`)
  }
  const output = new Map<string, string>()
  let bytes = 0
  for (const [name, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new TypeError(`package-manager environment name is not portable: ${JSON.stringify(name)}`)
    }
    if (value === undefined) continue
    if (value.includes("\0") || !isWellFormedText(value)) {
      throw new TypeError(`package-manager environment ${name} is not usable text`)
    }
    bytes += Buffer.byteLength(name, "utf8") + Buffer.byteLength(value, "utf8")
    if (!Number.isSafeInteger(bytes) || bytes > maximumEnvironmentBytes) {
      throw new TypeError(`package-manager environment exceeds ${maximumEnvironmentBytes} bytes`)
    }
    const key = options.platform.os === "win32" ? name.toUpperCase() : name
    if (output.has(key)) {
      throw new TypeError(`package-manager environment repeats a case-insensitive name: ${JSON.stringify(name)}`)
    }
    output.set(key, value)
  }
  return output
}

/** Refuses malformed host configuration before any service or child exists. */
const validateOptions = (options: Options): void => {
  const root = options.projectRoot
  if (
    typeof root !== "string" ||
    root.length === 0 ||
    root.includes("\0") ||
    !isWellFormedText(root) ||
    Buffer.byteLength(root, "utf8") > 32 * 1024 ||
    !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(root)
  ) {
    throw new TypeError("package-manager projectRoot must be a usable absolute path")
  }
  for (const [name, value] of [
    ["platform.os", options.platform.os],
    ["platform.arch", options.platform.arch],
    ["platform.libc", options.platform.libc]
  ] as const) {
    if (
      value !== null &&
      (typeof value !== "string" || value.length === 0 || value.includes("\0") ||
        !isWellFormedText(value) || Buffer.byteLength(value, "utf8") > 256)
    ) {
      throw new TypeError(`package-manager ${name} must be non-empty usable text no longer than 256 bytes`)
    }
  }
  if (
    options.executable !== undefined &&
    (options.executable.length === 0 || options.executable.includes("\0") ||
      !isWellFormedText(options.executable) || Buffer.byteLength(options.executable, "utf8") > 32 * 1024)
  ) {
    throw new TypeError("package-manager executable must be usable non-empty text")
  }
  timeoutOf(options)
  environmentSource(options)
}

const sourceValue = (source: ReadonlyMap<string, string>, name: string, windows: boolean): string | undefined =>
  source.get(windows ? name.toUpperCase() : name)

/** Variables that can mutate the runtime or package-manager command itself. */
const unsafeReferencedEnvironmentName = (name: string): boolean =>
  /^(?:BASH_ENV|BUN_.+|CDPATH|COREPACK_.+|DENO_.+|DYLD_.+|ENV|GIT_.+|GLOBIGNORE|LD_.+|NODE_.+|NPM_CONFIG_.+|PNPM_.+|SHELLOPTS)$/i.test(
    name
  )

const decodedText = (bytes: Uint8Array, path: string): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw new Error(`${path} is not valid UTF-8`)
  }
}

const fileIdentity = (info: FileSystem.File.Info): string =>
  `${info.dev}:${Option.getOrUndefined(info.ino) ?? "none"}:${info.size}:` +
  `${Option.getOrUndefined(info.mtime)?.getTime() ?? "none"}`

/** Reads one descriptor-stable regular file while enforcing an actual byte limit. */
const boundedText = (
  fs: FileSystem.FileSystem,
  code: ErrorCode,
  path: string,
  limit: number
): Effect.Effect<string, PackageManagerError> =>
  Effect.scoped(
    Effect.gen(function*() {
      // Reject stable FIFOs, sockets, devices, and directories before open;
      // opening a FIFO for reading can otherwise wait forever for a writer.
      const before = yield* fs.stat(path).pipe(Effect.mapError((cause) => unreadable(code, path, cause)))
      if (before.type !== "File" || before.size > BigInt(limit)) {
        return yield* Effect.fail(
          unreadable(code, path, new Error(`expected a regular file no larger than ${limit} bytes`))
        )
      }
      const file = yield* fs.open(path, { flag: "r" }).pipe(
        Effect.mapError((cause) => unreadable(code, path, cause))
      )
      const info = yield* file.stat.pipe(Effect.mapError((cause) => unreadable(code, path, cause)))
      if (info.type !== "File" || info.size > BigInt(limit)) {
        return yield* Effect.fail(
          unreadable(code, path, new Error(`expected a regular file no larger than ${limit} bytes`))
        )
      }
      if (fileIdentity(before) !== fileIdentity(info)) {
        return yield* Effect.fail(unreadable(code, path, new Error("file changed while it was opened")))
      }
      const chunks: Array<Uint8Array> = []
      let length = 0
      while (length <= limit) {
        const buffer = new Uint8Array(Math.min(64 * 1024, limit + 1 - length))
        const read = Number(yield* file.read(buffer).pipe(
          Effect.mapError((cause) => unreadable(code, path, cause))
        ))
        if (read === 0) break
        chunks.push(buffer.subarray(0, read))
        length += read
      }
      if (length > limit) {
        return yield* Effect.fail(unreadable(code, path, new Error(`file exceeds ${limit} bytes`)))
      }
      const after = yield* file.stat.pipe(Effect.mapError((cause) => unreadable(code, path, cause)))
      if (fileIdentity(info) !== fileIdentity(after)) {
        return yield* Effect.fail(unreadable(code, path, new Error("file changed while it was read")))
      }
      const bytes = new Uint8Array(length)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
      return yield* Effect.try({
        try: () => decodedText(bytes, path),
        catch: (cause) => unreadable(code, path, cause)
      })
    })
  )

/** Selects only bootstrap, network, and project-declared credential variables. */
const managerEnvironment = (
  fs: FileSystem.FileSystem,
  options: Options
): Effect.Effect<Record<string, string>, PackageManagerError> =>
  Effect.gen(function*() {
    const source = yield* Effect.try({
      try: () => environmentSource(options),
      catch: (cause) => new PackageManagerError({ code: "unsafe_configuration", message: failureMessage(cause), cause })
    })
    const path = `${options.projectRoot}/.npmrc`
    const present = yield* fs.exists(path).pipe(
      Effect.mapError((cause) => unreadable("manifest_unreadable", path, cause))
    )
    const npmrc = present ? yield* boundedText(fs, "manifest_unreadable", path, maximumNpmrcBytes) : ""
    if (hasEmbeddedNpmCredential(npmrc)) {
      return yield* Effect.fail(
        new PackageManagerError({
          code: "unsafe_configuration",
          message: `${path} embeds a credential; use an environment-variable placeholder`
        })
      )
    }
    const referenced = new Set<string>()
    for (const match of npmrc.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) referenced.add(match[1]!)
    const windows = options.platform.os === "win32"
    const env: Record<string, string> = {
      CI: "true",
      CLICOLOR: "0",
      FORCE_COLOR: "0",
      LANG: "C",
      LC_ALL: "C",
      NO_COLOR: "1",
      NPM_CONFIG_GLOBALCONFIG: windows ? "NUL" : "/dev/null",
      NPM_CONFIG_USERCONFIG: windows ? "NUL" : "/dev/null"
    }
    for (const name of referenced) {
      if (unsafeReferencedEnvironmentName(name)) {
        return yield* Effect.fail(
          new PackageManagerError({
            code: "unsafe_configuration",
            message: `${path} references process-control environment variable ${name}`
          })
        )
      }
    }
    for (const name of [...bootstrapEnvironment, ...referenced]) {
      const value = sourceValue(source, name, windows)
      if (value !== undefined && env[name] === undefined) env[name] = value
    }
    return env
  })

interface ByteState {
  buffer: Uint8Array
  length: number
}

const collectVersion = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>): Effect.Effect<Uint8Array, unknown> =>
  Stream.runFoldEffect(
    stream,
    (): ByteState => ({ buffer: new Uint8Array(1024), length: 0 }),
    (state, chunk) => {
      const length = state.length + chunk.byteLength
      if (!Number.isSafeInteger(length) || length > maximumVersionOutputBytes) {
        return Effect.fail(new Error(`version output exceeds ${maximumVersionOutputBytes} bytes`))
      }
      if (length > state.buffer.byteLength) {
        let capacity = state.buffer.byteLength
        while (capacity < length) capacity = Math.min(maximumVersionOutputBytes, capacity * 2)
        const grown = new Uint8Array(capacity)
        grown.set(state.buffer.subarray(0, state.length))
        state.buffer = grown
      }
      state.buffer.set(chunk, state.length)
      state.length = length
      return Effect.succeed(state)
    }
  ).pipe(Effect.map((state) => state.buffer.subarray(0, state.length)))

/** Constructs a child that receives only explicitly selected capabilities. */
const managerCommand = (
  executable: string,
  args: ReadonlyArray<string>,
  projectRoot: string,
  environment: Record<string, string>,
  output: "capture" | "inherit"
): ChildProcess.Command =>
  ChildProcess.make(executable, args, {
    cwd: projectRoot,
    env: environment,
    extendEnv: false,
    stdin: "ignore",
    stdout: output === "capture" ? "pipe" : "inherit",
    stderr: "inherit",
    killSignal: "SIGKILL"
  })

/**
 * Runs a command and refuses a non-zero status.
 *
 * @private
 */
const run = (
  spawner: ChildProcessSpawner["Service"],
  label: string,
  command: ChildProcess.Command,
  timeoutMs: number
): Effect.Effect<void, PackageManagerError> =>
  spawner.exitCode(command).pipe(
    Effect.mapError((cause) => failedToStart(label, cause)),
    Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: () => Effect.fail(failedToFinish(label, timeoutMs))
    }),
    Effect.flatMap((status) => status === 0 ? Effect.void : Effect.fail(failedToRun(label, status)))
  )

/**
 * Runs a command and returns its trimmed standard output.
 *
 * @private
 */
const capture = (
  spawner: ChildProcessSpawner["Service"],
  label: string,
  command: ChildProcess.Command,
  timeoutMs: number
): Effect.Effect<string, PackageManagerError> =>
  Effect.scoped(
    Effect.flatMap(spawner.spawn(command), (handle) =>
      Effect.all([collectVersion(handle.stdout), handle.exitCode], { concurrency: "unbounded" }))
  ).pipe(
    Effect.mapError((cause) => failedToStart(label, cause)),
    Effect.timeoutOrElse({
      duration: Math.min(timeoutMs, 30_000),
      orElse: () => Effect.fail(failedToFinish(label, Math.min(timeoutMs, 30_000)))
    }),
    Effect.flatMap(([output, status]) => status === 0 ? Effect.succeed(output) : Effect.fail(failedToRun(label, status))),
    Effect.flatMap((output) =>
      Effect.try({
        try: () => {
          const text = decodedText(output, `${label} stdout`).trim()
          if (text === "") throw new Error(`${label} returned an empty version`)
          if (/\r|\n|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
            throw new Error(`${label} returned more than one line or control characters`)
          }
          return text
        },
        catch: (cause) => failedToStart(label, cause)
      })
    )
  )

/**
 * Digests text with the injected `Crypto` service.
 *
 * @private
 */
const digestText = (text: string): Effect.Effect<Digest, never, Crypto.Crypto> =>
  Effect.orDie(Schema.decodeUnknownEffect(Sha256)(text))

/**
 * Digests a file's contents, reporting an unreadable file as a typed failure
 * rather than a defect.
 *
 * @private
 */
const digestFile = (
  fs: FileSystem.FileSystem,
  code: ErrorCode,
  path: string,
  limit: number
): Effect.Effect<Digest, PackageManagerError, Crypto.Crypto> =>
  boundedText(fs, code, path, limit).pipe(Effect.flatMap(digestText))

/**
 * Builds the explicit unsupported npm implementation.
 *
 * npm has no command that populates cacache from `package-lock.json` while
 * verifying each downloaded tarball against the lockfile's integrity field.
 * `npm cache add <resolved-url>` can warm the cache, but it does not make the
 * fetch action a Bazel-style verified repository fetch. Publishing that store
 * as a successful hard-boundary result would be a false hermeticity claim.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNpm = (options: Options): Effect.Effect<
  Service,
  never
> => Effect.succeed(makeNoop("npm", options))

/**
 * Provides the npm implementation.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNpm = (
  options: Options
): Layer.Layer<PackageManager, never, ChildProcessSpawner | FileSystem.FileSystem> =>
  Layer.effect(PackageManager)(makeNpm(options))

/**
 * Builds the pnpm implementation.
 *
 * pnpm is the manager the split was designed around: `pnpm fetch` reads the
 * lockfile, ignores the package manifest, and populates the store, and
 * `pnpm install --offline --frozen-lockfile` links out of it. The command is
 * still marked experimental by pnpm itself. That does not change the split.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makePnpm = (options: Options): Effect.Effect<
  Service,
  never,
  ChildProcessSpawner | FileSystem.FileSystem
> =>
  Effect.sync(() => validateOptions(options)).pipe(Effect.andThen(Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner
    const fs = yield* FileSystem.FileSystem
    const executable = options.executable ?? "pnpm"
    const projectRoot = options.projectRoot
    const timeoutMs = timeoutOf(options)
    const storeDirectory = `${storeRoot}/pnpm`
    const storeArgs = ["--store-dir", `${projectRoot}/${storeDirectory}`]
    const command = (label: string, args: ReadonlyArray<string>) =>
      Effect.flatMap(managerEnvironment(fs, options), (environment) =>
        run(spawner, label, managerCommand(executable, args, projectRoot, environment, "inherit"), timeoutMs))
    return {
      name: "pnpm",
      projectRoot,
      storeDirectory,
      lockfileName: "pnpm-lock.yaml",
      platformSensitive: true,
      platform: options.platform,
      version: Effect.flatMap(managerEnvironment(fs, options), (environment) =>
        capture(
          spawner,
          "pnpm --version",
          managerCommand(executable, ["--version"], projectRoot, environment, "capture"),
          timeoutMs
        )),
      fetch: command(
        "pnpm fetch",
        ["fetch", "--frozen-lockfile", "--ignore-scripts", "--reporter=append-only", ...storeArgs]
      ),
      link: command(
        "pnpm install --offline",
        [
          "install",
          "--offline",
          "--frozen-lockfile",
          "--ignore-scripts",
          "--reporter=append-only",
          ...storeArgs
        ]
      ),
      // pnpm records the state of the virtual store it linked from.
      linkManifest: digestFile(
        fs,
        "manifest_unreadable",
        `${projectRoot}/node_modules/.modules.yaml`,
        maximumLockfileBytes
      )
    } satisfies Service
  })))

/**
 * Provides the pnpm implementation.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerPnpm = (
  options: Options
): Layer.Layer<PackageManager, never, ChildProcessSpawner | FileSystem.FileSystem> =>
  Layer.effect(PackageManager)(makePnpm(options))

/**
 * Builds the explicit unsupported Bun implementation.
 *
 * Bun currently exposes neither a fetch-only command with a documented store
 * result nor an offline install command. Treating `install --dry-run` as a
 * successful hard-boundary fetch would publish a cache entry without proof
 * that its declared store contains everything link needs. Refusing the three
 * operations is safer than presenting that best-effort behavior as sealed.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeBun = (options: Options): Effect.Effect<
  Service,
  never
> => Effect.succeed(makeNoop("bun", options))

/**
 * Provides the Bun implementation.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerBun = (
  options: Options
): Layer.Layer<PackageManager, never, ChildProcessSpawner | FileSystem.FileSystem> =>
  Layer.effect(PackageManager)(makeBun(options))

/**
 * Builds a manager that refuses every operation.
 *
 * This is what an unconfigured composition gets, and what a browser bundle
 * gets: the seam still resolves, and each call answers with a typed
 * `unsupported` failure naming the manager instead of vanishing. It is also
 * the explicit stand-in for Yarn until the Yarn implementation lands.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (name: Name, options: Options): Service => {
  validateOptions(options)
  const refuse = <A>(operation: string): Effect.Effect<A, PackageManagerError> =>
    Effect.fail(
      new PackageManagerError({
        code: "unsupported",
        message: `no ${name} implementation is wired for ${operation}`
      })
    )
  return {
    name,
    projectRoot: options.projectRoot,
    storeDirectory: `${storeRoot}/${name}`,
    lockfileName: name === "yarn"
      ? "yarn.lock"
      : name === "bun"
      ? "bun.lock"
      : name === "pnpm"
      ? "pnpm-lock.yaml"
      : "package-lock.json",
    platformSensitive: true,
    platform: options.platform,
    version: refuse("version"),
    fetch: refuse("fetch"),
    link: refuse("link"),
    linkManifest: refuse("linkManifest")
  }
}

/**
 * Provides a manager that refuses every operation.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop = (name: Name, options: Options): Layer.Layer<PackageManager> =>
  Layer.succeed(PackageManager)(makeNoop(name, options))

/**
 * The canonical text a store manifest digest is taken over.
 *
 * It is built here rather than by a JSON serializer so the field order is
 * fixed by this function and not by object construction order. The version
 * prefix is hashed with everything else, so a change to this shape can never
 * collide with a digest minted under the old one.
 *
 * @category constructors
 * @since 0.1.0
 */
export const storeManifestText = (input: {
  readonly manager: Name
  readonly managerVersion: string
  readonly platform: Platform | null
  readonly lockfileDigest: string
  readonly npmrcDigest: string | null
}): string =>
  JSON.stringify([
    "tsflows/store-manifest/v1",
    input.manager,
    input.managerVersion,
    input.platform === null
      ? null
      : [input.platform.os, input.platform.arch, input.platform.libc],
    input.lockfileDigest,
    input.npmrcDigest
  ])

/**
 * Computes the store manifest a fetch reports.
 *
 * @category constructors
 * @since 0.1.0
 */
export const storeManifest = (input: {
  readonly manager: Name
  readonly managerVersion: string
  readonly platform: Platform | null
  readonly lockfileDigest: string
  readonly npmrcDigest: string | null
}): Effect.Effect<StoreManifest, never, Crypto.Crypto> =>
  Effect.map(digestText(storeManifestText(input)), (digest) => ({
    manager: input.manager,
    managerVersion: input.managerVersion,
    platform: input.platform,
    digest
  }))

/**
 * Computes the digest used to decide whether a linked tree is still fresh.
 *
 * The manager evidence describes the tree it produced. The store digest and
 * root package manifest describe what it was asked to produce. Folding all
 * three prevents a changed `package.json` from reusing an old local marker.
 *
 * @category constructors
 * @since 0.1.0
 */
export const linkedTreeManifest = (input: {
  readonly storeDigest: Digest
  readonly packageJsonDigest: Digest
  readonly managerEvidence: Digest
}): Effect.Effect<Digest, never, Crypto.Crypto> =>
  digestText(JSON.stringify([
    "tsflows/linked-tree-manifest/v1",
    input.storeDigest,
    input.packageJsonDigest,
    input.managerEvidence
  ]))

/**
 * Reports whether `.npmrc` embeds a credential instead of referring to an
 * environment variable.
 *
 * The hard boundary hashes the complete file. Literal credentials therefore
 * cannot be allowed in it. A value such as `${NPM_TOKEN}` is safe because the
 * file contains only the variable name. The environment value remains a host
 * capability and never enters the key or journal.
 *
 * @private
 */
const hasEmbeddedNpmCredential = (text: string): boolean => {
  const credential = /(_auth|_authtoken|_password|token|certfile|keyfile)\s*=/i
  const environment = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/
  return text.split("\n").some((raw) => {
    const line = raw.trim()
    if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) return false
    const separator = line.indexOf("=")
    if (separator < 0 || !credential.test(line.slice(0, separator + 1))) return false
    return !environment.test(line.slice(separator + 1).trim())
  })
}

/**
 * Digests the `.npmrc` that applies to a project, if there is one.
 *
 * The complete project-level file is digested. Literal credentials are
 * refused because the boundary also hashes this file. Use environment
 * placeholders for credentials. User-level and host-level configuration is
 * out of scope because a sealed step cannot key hidden files under `$HOME`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const npmrcDigest = (
  projectRoot: string
): Effect.Effect<Digest | null, PackageManagerError, FileSystem.FileSystem | Crypto.Crypto> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = `${projectRoot}/.npmrc`
    const present = yield* fs.exists(path).pipe(
      Effect.mapError((cause) => unreadable("manifest_unreadable", path, cause))
    )
    if (!present) return null
    const text = yield* boundedText(fs, "manifest_unreadable", path, maximumNpmrcBytes)
    if (hasEmbeddedNpmCredential(text)) {
      return yield* Effect.fail(
        new PackageManagerError({
          code: "unsafe_configuration",
          message: `${path} embeds a credential; use an environment-variable placeholder`
        })
      )
    }
    return yield* digestText(text)
  })

/**
 * Digests a project's lockfile.
 *
 * @category constructors
 * @since 0.1.0
 */
export const lockfileDigest = (
  projectRoot: string,
  lockfileName: string
): Effect.Effect<Digest, PackageManagerError, FileSystem.FileSystem | Crypto.Crypto> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    return yield* digestFile(
      fs,
      "lockfile_unreadable",
      `${projectRoot}/${lockfileName}`,
      maximumLockfileBytes
    )
  })

/**
 * Digests the root package manifest used by the link phase.
 *
 * @category constructors
 * @since 0.1.0
 */
export const packageJsonDigest = (
  projectRoot: string
): Effect.Effect<Digest, PackageManagerError, FileSystem.FileSystem | Crypto.Crypto> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    return yield* digestFile(
      fs,
      "manifest_unreadable",
      `${projectRoot}/package.json`,
      maximumPackageJsonBytes
    )
  })
