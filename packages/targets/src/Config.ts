/**
 * Workspace configuration declared in the root BUILD.ts file.
 *
 * A configuration value is inert: {@link Workspace} validates its fields and
 * performs no I/O, so BUILD.ts evaluation stays pure. The CLI discovers the
 * declaration and resolves it against the `--cache-dir` flag. The CLI passes
 * the result explicitly to input expansion and tool execution as host state.
 *
 * The resolved cache directory is explicit host state rather than target attrs
 * on purpose. It names where scratch and cache files live on one host, so it
 * must never reach a cache key or a content digest.
 *
 * @since 0.1.0
 */
import * as NodeUtil from "node:util/types"

/**
 * Runtime marker for a workspace configuration declaration.
 *
 * @category type ids
 * @since 0.1.0
 */
export const TypeId: unique symbol = Symbol.for("smithers-build/Workspace") as never

/**
 * The cache directory used when no BUILD.ts declaration and no flag name one.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultCacheDirectory = ".flows"

/**
 * Maximum UTF-8 size of a normalized cache-directory path.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumCacheDirectoryBytes = 4 * 1024

/**
 * Maximum UTF-8 size of one cache-directory path segment.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumCacheDirectorySegmentBytes = 255

/**
 * A pure workspace configuration declaration.
 *
 * `cacheDirectory` is a workspace-relative directory holding the result cache
 * and target scratch files. `gitignored` asks the CLI to keep a root
 * `.gitignore` entry for it. `sandbox` carries the projection mode and the
 * host environment names a tool run may read.
 *
 * @category models
 * @since 0.1.0
 */
export interface Workspace {
  readonly [TypeId]: typeof TypeId
  readonly cacheDirectory: string
  readonly gitignored: boolean
  readonly sandbox: Sandbox
}

/**
 * Options accepted by {@link Workspace}.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  /** @default ".flows" */
  readonly cacheDirectory?: string | undefined
  /** @default false */
  readonly gitignored?: boolean | undefined
  /** @default { projection: "declared", environment: [] } */
  readonly sandbox?: SandboxOptions | undefined
}


/**
 * Maximum number of environment names one workspace may declare.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumDeclaredEnvironmentNames = 256

/**
 * How much of the workspace a tool run sees.
 *
 * - `off` runs every tool against the whole workspace and ignores a rule that
 *   asks for projection. It is the kill switch.
 * - `declared` lets each rule decide. A rule that says nothing runs against the
 *   whole workspace, which is what every rule in the catalog does today.
 * - `forced` projects every tool run whether or not its rule asked for it. A
 *   target whose declared inputs are incomplete fails, which is the point.
 *
 * @category models
 * @since 0.1.0
 */
export type Projection = "off" | "declared" | "forced"

/**
 * The workspace sandbox policy.
 *
 * `projection` selects the execution mode. `environment` lists host
 * environment names a tool may read in addition to the bootstrap allowlist
 * every spawn path starts from. A declared name is not a grant alone: its
 * value becomes key material, so a target that reads it is keyed on what it
 * read.
 *
 * Projection is a determinism boundary, not a security boundary. It decides
 * what a cooperating tool finds when it opens a declared path. A spawned
 * native process keeps the ambient authority of the user who spawned it.
 *
 * @category models
 * @since 0.1.0
 */
export interface Sandbox {
  readonly projection: Projection
  readonly environment: ReadonlyArray<string>
}

/**
 * Options accepted by the `sandbox` field of {@link Workspace}.
 *
 * @category models
 * @since 0.1.0
 */
export interface SandboxOptions {
  /** @default "declared" */
  readonly projection?: Projection | undefined
  /** @default [] */
  readonly environment?: ReadonlyArray<string> | undefined
}

/**
 * The sandbox policy used when no BUILD.ts declaration names one.
 *
 * Projection is opt-in and no rule opts in, so the default runs every target
 * exactly as it ran before projection existed.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultSandbox: Sandbox = Object.freeze({
  projection: "declared" as const,
  environment: Object.freeze([]) as ReadonlyArray<string>
})

const portableEnvironmentName = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Validates one declared sandbox policy.
 *
 * Environment names are deduplicated and sorted, so two spellings of one
 * declaration produce one policy and therefore one key.
 *
 * @category validation
 * @since 0.1.0
 */
export const normalizeSandbox = (value: unknown): Sandbox => {
  if (
    typeof value !== "object" || value === null || NodeUtil.isProxy(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) throw new TypeError("Workspace option sandbox must be a plain object")
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError("Workspace option sandbox must not contain symbol properties")
  }
  for (const name of Object.getOwnPropertyNames(value)) {
    if (name !== "projection" && name !== "environment") {
      throw new TypeError(`Workspace option sandbox received unknown option ${JSON.stringify(name)}`)
    }
  }
  const read = (name: "projection" | "environment"): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(value, name)
    if (descriptor === undefined) return undefined
    if (!("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`Workspace option sandbox.${name} must be an enumerable data property`)
    }
    return descriptor.value
  }
  const projection = read("projection")
  if (
    projection !== undefined && projection !== "off" && projection !== "declared" && projection !== "forced"
  ) {
    throw new TypeError('Workspace option sandbox.projection must be "off", "declared", or "forced"')
  }
  const declared = read("environment")
  if (declared !== undefined && (!Array.isArray(declared) || NodeUtil.isProxy(declared))) {
    throw new TypeError("Workspace option sandbox.environment must be an array")
  }
  const names: Array<string> = []
  const seen = new Set<string>()
  for (const name of declared === undefined ? [] : (declared as ReadonlyArray<unknown>)) {
    if (typeof name !== "string" || !portableEnvironmentName.test(name)) {
      throw new TypeError(
        `Workspace option sandbox.environment must contain portable environment names: ${JSON.stringify(name)}`
      )
    }
    if (seen.has(name)) continue
    seen.add(name)
    names.push(name)
  }
  if (names.length > maximumDeclaredEnvironmentNames) {
    throw new Error(
      `Workspace option sandbox.environment names at most ${maximumDeclaredEnvironmentNames} variables`
    )
  }
  names.sort()
  return Object.freeze({
    projection: (projection ?? "declared") as Projection,
    environment: Object.freeze(names) as ReadonlyArray<string>
  })
}

/**
 * Checks whether a value is a sandbox policy.
 *
 * @category guards
 * @since 0.1.0
 */
export const isSandbox = (value: unknown): value is Sandbox => {
  if (typeof value !== "object" || value === null || NodeUtil.isProxy(value)) return false
  const own = (key: PropertyKey): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined
  }
  const projection = own("projection")
  const environment = own("environment")
  return (projection === "off" || projection === "declared" || projection === "forced") &&
    Array.isArray(environment) && environment.every((name) => typeof name === "string")
}

const absolute = /^([/\\]|[A-Za-z]:)/

/**
 * Validates one declared cache directory and returns its normalized posix
 * form.
 *
 * The value names a single workspace-relative directory. Surrounding
 * whitespace, redundant separators, and `.` segments are dropped. An empty
 * value, an absolute path, and any `..` segment are refused, so the directory
 * can never escape the workspace.
 *
 * @category validation
 * @since 0.1.0
 */
export const normalizeCacheDirectory = (value: string): string => {
  if (typeof value !== "string") throw new TypeError("cacheDirectory must be a string")
  if (value.length > maximumCacheDirectoryBytes) {
    throw new Error(`cacheDirectory must be at most ${maximumCacheDirectoryBytes} UTF-8 bytes`)
  }
  const trimmed = value.trim()
  if (trimmed === "") throw new Error("cacheDirectory must not be empty")
  if (!trimmed.isWellFormed() || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new Error("cacheDirectory must be well-formed text without control characters")
  }
  if (absolute.test(trimmed)) throw new Error(`cacheDirectory must be workspace-relative: ${value}`)
  const segments = trimmed.split(/[/\\]/).filter((segment) => segment !== "" && segment !== ".")
  if (segments.length === 0) throw new Error("cacheDirectory must not be empty")
  if (segments.includes("..")) throw new Error(`cacheDirectory must not leave the workspace: ${value}`)
  const encoder = new TextEncoder()
  for (const segment of segments) {
    if (encoder.encode(segment).byteLength > maximumCacheDirectorySegmentBytes) {
      throw new Error(
        `cacheDirectory segments must be at most ${maximumCacheDirectorySegmentBytes} UTF-8 bytes`
      )
    }
  }
  const normalized = segments.join("/")
  if (encoder.encode(normalized).byteLength > maximumCacheDirectoryBytes) {
    throw new Error(`cacheDirectory must be at most ${maximumCacheDirectoryBytes} UTF-8 bytes`)
  }
  return normalized
}

/**
 * Creates a pure workspace configuration declaration using BUILD.ts syntax.
 *
 * @example
 * ```ts
 * import { Smithers } from "@smthrs/targets"
 *
 * export const workspace = Smithers.Workspace({
 *   cacheDirectory: ".flows",
 *   gitignored: true
 * })
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const Workspace = (options: Options = {}): Workspace => {
  if (
    typeof options !== "object" || options === null || NodeUtil.isProxy(options) ||
    (Object.getPrototypeOf(options) !== Object.prototype && Object.getPrototypeOf(options) !== null)
  ) throw new TypeError("Workspace options must be a plain object")
  const names = Object.getOwnPropertyNames(options)
  if (Object.getOwnPropertySymbols(options).length > 0) {
    throw new TypeError("Workspace options must not contain symbol properties")
  }
  for (const name of names) {
    if (name !== "cacheDirectory" && name !== "gitignored" && name !== "sandbox") {
      throw new TypeError(`Workspace received unknown option ${JSON.stringify(name)}`)
    }
  }
  const read = (name: "cacheDirectory" | "gitignored" | "sandbox"): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(options, name)
    if (descriptor === undefined) return undefined
    if (!("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`Workspace option ${name} must be an enumerable data property`)
    }
    return descriptor.value
  }
  const cacheDirectory = read("cacheDirectory")
  const gitignored = read("gitignored")
  const sandbox = read("sandbox")
  if (cacheDirectory !== undefined && typeof cacheDirectory !== "string") {
    throw new TypeError("Workspace option cacheDirectory must be a string")
  }
  if (gitignored !== undefined && typeof gitignored !== "boolean") {
    throw new TypeError("Workspace option gitignored must be a boolean")
  }
  return Object.freeze<Workspace>({
    [TypeId]: TypeId,
    cacheDirectory: cacheDirectory === undefined
      ? defaultCacheDirectory
      : normalizeCacheDirectory(cacheDirectory),
    gitignored: gitignored ?? false,
    sandbox: sandbox === undefined ? defaultSandbox : normalizeSandbox(sandbox)
  })
}

/**
 * Checks whether a BUILD.ts export is a workspace configuration declaration.
 *
 * @category guards
 * @since 0.1.0
 */
export const isWorkspace = (value: unknown): value is Workspace => {
  if (typeof value !== "object" || value === null || NodeUtil.isProxy(value)) return false
  const own = (key: PropertyKey): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined
  }
  // A missing sandbox is accepted deliberately. Recognition decides whether a
  // value is a declaration at all, and a declaration that fails recognition is
  // ignored rather than validated. Requiring a field the constructor adds would
  // therefore turn a structurally forged declaration with a bad cache directory
  // from a refusal into a silent fallback to the defaults.
  const sandbox = own("sandbox")
  return own(TypeId) === TypeId &&
    typeof own("cacheDirectory") === "string" &&
    typeof own("gitignored") === "boolean" &&
    (sandbox === undefined || isSandbox(sandbox))
}
