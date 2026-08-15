/**
 * Runtime adapter between the CLI and the install package.
 *
 * Every assumption about the install package's exports stays in this file, so
 * a surface change there reconciles in one place. The executor composes the
 * layers exported here beside each target's own interpreter registration.
 *
 * @since 0.1.0
 */
import { NodeServices } from "@effect/platform-node"
import { FlowEngine } from "@smthrs/engine-next"
import { Action, Graph, Interpreter } from "@smthrs/flow-next"
import { Install, PackageManager } from "@smthrs/tsflows-next"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { createHash } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"
import * as Config from "tsflows-rules/Config"

/**
 * Structured result returned by the install command.
 *
 * @category models
 * @since 0.1.0
 */
export interface InstallResult {
  readonly workspace: string
  readonly manager: "pnpm"
  readonly plan: ReadonlyArray<{
    readonly id: string
    readonly kind: string
    readonly dependencies: ReadonlyArray<string>
  }>
  readonly result: Install.LinkManifest
}

const normalizeSensitiveEnvironment = (value: unknown): ReadonlyArray<string> => {
  let length: number
  try {
    if (!Array.isArray(value)) throw new TypeError("sensitiveEnvironment must be an array")
    const descriptor = Object.getOwnPropertyDescriptor(value, "length")
    if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "number") {
      throw new TypeError("sensitiveEnvironment length is invalid")
    }
    length = descriptor.value
  } catch {
    throw new TypeError("sensitiveEnvironment must be an inspectable array of at most 64 names")
  }
  if (!Number.isSafeInteger(length) || length < 0 || length > 64) {
    throw new TypeError("sensitiveEnvironment must be an array of at most 64 names")
  }
  const names: Array<string> = []
  for (let index = 0; index < length; index += 1) {
    let descriptor: PropertyDescriptor | undefined
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    } catch {
      throw new TypeError("sensitiveEnvironment could not be inspected safely")
    }
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError("sensitiveEnvironment must contain only data entries")
    }
    const name = descriptor.value
    if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new TypeError("sensitiveEnvironment contains an invalid environment name")
    }
    names.push(name)
  }
  return Object.freeze(names)
}

/**
 * Copies the host environment without remote-cache credentials.
 *
 * The package-manager implementation selects only its own bootstrap and
 * project-declared variables from this copy. Removing cache credentials here
 * also covers a custom token name that a project `.npmrc` happens to mention.
 *
 * @category security
 * @since 0.1.0
 */
export const packageManagerEnvironment = (
  source: Readonly<Record<string, string | undefined>>,
  sensitiveEnvironment: ReadonlyArray<string> = [],
  windows = process.platform === "win32"
): Readonly<Record<string, string | undefined>> => {
  if (typeof windows !== "boolean") throw new TypeError("windows must be a boolean")
  const sensitiveNames = normalizeSensitiveEnvironment(sensitiveEnvironment)
  const blocked = new Set(
    ["TSFLOWS_CACHE_TOKEN", "TSFLOWS_CACHE_URL", ...sensitiveNames]
      .map((name) => windows ? name.toUpperCase() : name)
  )
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    throw new TypeError("environment source must be an object")
  }
  let keys: Array<string | symbol>
  try {
    keys = Reflect.ownKeys(source)
  } catch {
    throw new TypeError("environment source could not be inspected safely")
  }
  if (keys.length > 4_096) throw new TypeError("environment source has more than 4096 entries")
  const output: Array<readonly [string, string]> = []
  const seen = new Set<string>()
  let bytes = 0
  for (const key of keys) {
    if (typeof key !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new TypeError("environment source contains a non-portable name")
    }
    let descriptor: PropertyDescriptor | undefined
    try {
      descriptor = Object.getOwnPropertyDescriptor(source, key)
    } catch {
      throw new TypeError("environment source could not be inspected safely")
    }
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`environment source ${key} must be an enumerable data property`)
    }
    const member = descriptor.value
    if (member !== undefined && typeof member !== "string") {
      throw new TypeError(`environment source ${key} must be a string or undefined`)
    }
    if (typeof member === "string") {
      if (member.includes("\0") || !member.isWellFormed()) {
        throw new TypeError(`environment source ${key} is not usable text`)
      }
      bytes += Buffer.byteLength(key, "utf8") + Buffer.byteLength(member, "utf8")
      if (!Number.isSafeInteger(bytes) || bytes > 256 * 1024) {
        throw new TypeError("environment source exceeds 262144 bytes")
      }
    }
    const normalizedName = windows ? key.toUpperCase() : key
    if (seen.has(normalizedName)) {
      throw new TypeError(`environment source repeats a case-insensitive name: ${key}`)
    }
    seen.add(normalizedName)
    if (typeof member === "string" && !blocked.has(normalizedName)) output.push([key, member])
  }
  return Object.freeze(Object.fromEntries(output))
}

/**
 * The pnpm package-manager layer for this host.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerPackageManager = (
  projectRoot: string,
  sensitiveEnvironment: ReadonlyArray<string> = []
) => {
  const environment = packageManagerEnvironment(
    process.env,
    sensitiveEnvironment
  )
  return PackageManager.layerPnpm({
    projectRoot,
    environment,
    platform: {
      os: process.platform,
      arch: process.arch,
      libc: null
    }
  })
}

/**
 * The install action implementations plus the registered install flow.
 *
 * Registering the flow is what lets its round-one handoff resolve: the engine
 * looks the round-two flow up by tag among registered declarations. The
 * executor merges this beside a target's own interpreter registration so an
 * install target reached from any dependency graph can execute.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerInstall = Layer.mergeAll(
  Install.layer,
  Interpreter.layer(Install.Install)
)

const normalizeRunInstallOptions = (value: unknown): {
  readonly cacheDirectory: string
  readonly sensitiveEnvironment: ReadonlyArray<string>
  readonly signal: AbortSignal | undefined
} => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("install options must be a plain object")
  }
  let prototype: object | null
  let keys: Array<string | symbol>
  try {
    prototype = Object.getPrototypeOf(value) as object | null
    keys = Reflect.ownKeys(value)
  } catch {
    throw new TypeError("install options could not be inspected safely")
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("install options must be a plain object")
  }
  const allowed = new Set(["cacheDirectory", "sensitiveEnvironment", "signal"])
  for (const key of keys) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new TypeError(`install options contain an unknown property: ${String(key)}`)
    }
  }
  const read = (key: string): unknown => {
    let descriptor: PropertyDescriptor | undefined
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key)
    } catch {
      throw new TypeError(`install option ${key} could not be inspected safely`)
    }
    if (descriptor === undefined) return undefined
    if (!("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`install option ${key} must be an enumerable data property`)
    }
    return descriptor.value
  }
  const configuredCacheDirectory = read("cacheDirectory")
  if (configuredCacheDirectory !== undefined && typeof configuredCacheDirectory !== "string") {
    throw new TypeError("install cacheDirectory must be a string")
  }
  const configuredSignal = read("signal")
  if (configuredSignal !== undefined && !(configuredSignal instanceof AbortSignal)) {
    throw new TypeError("install signal must be an AbortSignal")
  }
  const sensitive = read("sensitiveEnvironment")
  return Object.freeze({
    cacheDirectory: Config.normalizeCacheDirectory(configuredCacheDirectory ?? Config.defaultCacheDirectory),
    sensitiveEnvironment: normalizeSensitiveEnvironment(sensitive ?? []),
    signal: configuredSignal
  })
}

/**
 * Plans and executes the install package's Install Flow under pnpm.
 *
 * The package-manager service carries the absolute workspace root, so this
 * operation never mutates the process-wide current directory and independent
 * callers can safely run against different workspaces at the same time.
 *
 * @category execution
 * @since 0.1.0
 */
export const runInstall = async (
  workspaceRoot: string,
  options: {
    readonly cacheDirectory?: string | undefined
    readonly sensitiveEnvironment?: ReadonlyArray<string> | undefined
    readonly signal?: AbortSignal | undefined
  } = {}
): Promise<InstallResult> => {
  if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0 || workspaceRoot.includes("\0")) {
    throw new TypeError("install workspaceRoot must be non-empty usable text")
  }
  const normalized = normalizeRunInstallOptions(options)
  normalized.signal?.throwIfAborted()
  if (normalized.cacheDirectory !== Config.defaultCacheDirectory) {
    throw new Error(
      `install requires cacheDirectory ${JSON.stringify(Config.defaultCacheDirectory)} because its declared ` +
        `store boundary is ${JSON.stringify(PackageManager.storeRoot)}; received ${
          JSON.stringify(normalized.cacheDirectory)
        }`
    )
  }
  const workspace = await Fs.realpath(NodePath.resolve(workspaceRoot))
  const runtime = layerInstall.pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(layerPackageManager(workspace, normalized.sensitiveEnvironment)),
    Layer.provideMerge(NodeServices.layer)
  )
  const graph = Graph.build(Install.Install, {})
  const executionId = `tsflows-install-${createHash("sha256").update(workspace).digest("hex").slice(0, 16)}`
  const result = await Effect.runPromise(
    Install.Install.execute({}, { executionId }).pipe(Effect.provide(runtime)),
    { signal: normalized.signal }
  )
  return {
    workspace,
    manager: "pnpm",
    plan: Graph.nodes(graph).map((node) => ({
      id: node.id,
      kind: node.kind,
      dependencies: node.dependencies
    })),
    result
  }
}
