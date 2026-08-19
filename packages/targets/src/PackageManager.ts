/**
 * Declared package manager for BUILD.ts targets.
 *
 * A package-manager declaration names which manager a workspace installs and
 * runs tools with, the version it requires, and the runtime that manager runs
 * under. It is inert data: the constructors validate and perform no I/O, so
 * BUILD.ts evaluation stays pure.
 *
 * Before this module every target spelled `["pnpm", "exec", ...]` into its own
 * argv. That made the manager an undeclared constant of the target catalog: a
 * workspace on npm could not use these targets at all, and no key recorded which
 * manager produced a result. A target now takes the declaration as an attr and
 * asks this module for the argv, so the manager is both swappable and covered
 * by key material.
 *
 * The declaration carries tool identity only. It deliberately does not carry
 * the lockfile: the lockfile is produced by the `Lockfile` target and consumed
 * by the `Install` target, and a target cannot be keyed on a file it produces.
 * Targets that need the installed tree depend on the `Install` target instead,
 * whose own key covers the lockfile.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"
import * as Runtime from "./Runtime.ts"

/**
 * Schema for the supported package managers.
 *
 * @category schemas
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
 * Maximum length of a declared version requirement.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumVersionLength = 256

/**
 * Schema for one declared package manager.
 *
 * @category schemas
 * @since 0.1.0
 */
export const PackageManager = Schema.TaggedStruct("PackageManager", {
  name: Name,
  version: Schema.NonEmptyString,
  executable: Schema.NonEmptyString,
  runtime: Runtime.Runtime
})

/**
 * One declared package manager.
 *
 * @category models
 * @since 0.1.0
 */
export type PackageManager = typeof PackageManager.Type

/**
 * Options accepted by the npm, pnpm, and Yarn constructors.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  /** The exact version, or version range, the workspace requires. */
  readonly version: string
  /** The runtime the manager itself runs under. */
  readonly runtime: Runtime.Runtime
  /** @default the manager name */
  readonly executable?: string | undefined
}

const controlCharacter = /[\u0000-\u001f\u007f]/

const usable = (value: unknown, what: string): string => {
  if (typeof value !== "string") throw new TypeError(`${what} must be a string`)
  if (
    value.length > maximumVersionLength ||
    !value.isWellFormed() ||
    controlCharacter.test(value)
  ) throw new Error(`${what} must be bounded well-formed text without control characters`)
  const trimmed = value.trim()
  if (trimmed === "") throw new Error(`${what} must not be empty`)
  return trimmed
}

/**
 * Creates a declared package manager.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (name: Name, options: Options): PackageManager => {
  if (!Runtime.isRuntime(options.runtime)) {
    throw new TypeError(`${name} requires a declared runtime, for example Runtime.Node({ version: ">=22.19.0" })`)
  }
  return PackageManager.make({
    name,
    version: usable(options.version, `${name} version`),
    executable: options.executable === undefined
      ? name
      : usable(options.executable, `${name} executable`),
    runtime: options.runtime
  })
}

/**
 * Declares npm as the workspace package manager.
 *
 * @category constructors
 * @since 0.1.0
 */
export const Npm = (options: Options): PackageManager => make("npm", options)

/**
 * Declares pnpm as the workspace package manager.
 *
 * @example
 * ```ts
 * import { Smithers } from "@smthrs/targets"
 *
 * const runtime = Smithers.Runtime.Node({ version: ">=22.19.0" })
 *
 * export const packageManager = Smithers.PackageManager.Pnpm({ version: "11.21.0", runtime })
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const Pnpm = (options: Options): PackageManager => make("pnpm", options)

/**
 * Declares Yarn as the workspace package manager.
 *
 * @category constructors
 * @since 0.1.0
 */
export const Yarn = (options: Options): PackageManager => make("yarn", options)

/**
 * Declares Bun as the workspace package manager.
 *
 * Bun is its own runtime, so this constructor takes no separate version: the
 * manager version is the runtime version, and declaring them apart would let a
 * BUILD.ts file state two versions of one program.
 *
 * @category constructors
 * @since 0.1.0
 */
export const BunPackages = (options: { readonly runtime: Runtime.Runtime }): PackageManager => {
  if (!Runtime.isRuntime(options.runtime) || options.runtime.name !== "bun") {
    throw new TypeError("BunPackages requires the Bun runtime, for example Runtime.Bun({ version: \">=1.3.0\" })")
  }
  return make("bun", { version: options.runtime.version, runtime: options.runtime })
}

/**
 * Checks whether a value is a declared package manager.
 *
 * @category guards
 * @since 0.1.0
 */
export const isPackageManager = (value: unknown): value is PackageManager => {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as { readonly _tag?: unknown; readonly name?: unknown }
  return candidate._tag === "PackageManager" && typeof candidate.name === "string"
}

/**
 * The lockfile each manager writes.
 *
 * This is a convention, not key material: it names where the `Lockfile` target
 * writes and where the `Install` target reads.
 *
 * @category constructors
 * @since 0.1.0
 */
export const lockfileName = (manager: PackageManager): string => {
  switch (manager.name) {
    case "npm":
      return "package-lock.json"
    case "pnpm":
      return "pnpm-lock.yaml"
    case "bun":
      return "bun.lock"
    case "yarn":
      return "yarn.lock"
  }
}

/**
 * Builds the argv that runs a workspace-installed tool.
 *
 * Every manager resolves a locally installed binary, and each spells it
 * differently. npm and Yarn need the `--` separator so a tool's own flags are
 * not eaten by the manager.
 *
 * @example
 * ```ts
 * import { Smithers } from "@smthrs/targets"
 *
 * const packageManager = Smithers.PackageManager.Pnpm({
 *   version: "11.21.0",
 *   runtime: Smithers.Runtime.Node({ version: ">=22.19.0" })
 * })
 *
 * // ["pnpm", "exec", "vitest", "run"]
 * const argv = Smithers.PackageManager.exec(packageManager, ["vitest", "run"])
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const exec = (manager: PackageManager, argv: ReadonlyArray<string>): Array<string> => {
  switch (manager.name) {
    case "npm":
      return [manager.executable, "exec", "--", ...argv]
    case "pnpm":
      return [manager.executable, "exec", ...argv]
    case "bun":
      return [manager.executable, "x", ...argv]
    case "yarn":
      return [manager.executable, "exec", ...argv]
  }
}

/**
 * Builds the argv that runs a tool the workspace has not installed.
 *
 * @category constructors
 * @since 0.1.0
 */
export const dlx = (manager: PackageManager, argv: ReadonlyArray<string>): Array<string> => {
  switch (manager.name) {
    case "npm":
      return [manager.executable, "exec", "--yes", "--", ...argv]
    case "pnpm":
      return [manager.executable, "dlx", ...argv]
    case "bun":
      return ["bunx", ...argv]
    case "yarn":
      return [manager.executable, "dlx", ...argv]
  }
}

/**
 * Builds the argv that publishes the package in the working directory.
 *
 * @category constructors
 * @since 0.1.0
 */
export const publish = (manager: PackageManager, args: ReadonlyArray<string> = []): Array<string> =>
  manager.name === "yarn"
    ? [manager.executable, "npm", "publish", ...args]
    : [manager.executable, "publish", ...args]

/**
 * Options accepted by {@link install}.
 *
 * @category models
 * @since 0.1.0
 */
export interface InstallOptions {
  /** Refuse to update the lockfile. @default true */
  readonly frozen?: boolean | undefined
  /** Resolve and write the lockfile without linking a tree. @default false */
  readonly lockfileOnly?: boolean | undefined
  /** Refuse to run package lifecycle scripts. @default true */
  readonly ignoreScripts?: boolean | undefined
}

/**
 * Builds the argv that installs the workspace.
 *
 * A frozen install is the default because an install that may rewrite the
 * lockfile is not reproducible, and because the lockfile is a generated file
 * with its own target.
 *
 * @category constructors
 * @since 0.1.0
 */
export const install = (manager: PackageManager, options: InstallOptions = {}): Array<string> => {
  const frozen = options.frozen ?? true
  const lockfileOnly = options.lockfileOnly ?? false
  const ignoreScripts = options.ignoreScripts ?? true
  const argv: Array<string> = [manager.executable, "install"]
  switch (manager.name) {
    case "npm": {
      if (lockfileOnly) argv.push("--package-lock-only")
      else if (frozen) argv[1] = "ci"
      if (ignoreScripts) argv.push("--ignore-scripts")
      return argv
    }
    case "pnpm": {
      if (frozen) argv.push("--frozen-lockfile")
      if (lockfileOnly) argv.push("--lockfile-only")
      if (ignoreScripts) argv.push("--ignore-scripts")
      return argv
    }
    case "bun": {
      if (frozen) argv.push("--frozen-lockfile")
      if (lockfileOnly) argv.push("--lockfile-only")
      if (ignoreScripts) argv.push("--ignore-scripts")
      return argv
    }
    case "yarn": {
      if (frozen) argv.push("--immutable")
      if (lockfileOnly) argv.push("--mode=update-lockfile")
      if (ignoreScripts) argv.push("--mode=skip-build")
      return argv
    }
  }
}
