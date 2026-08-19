/**
 * Declared JavaScript runtime for BUILD.ts targets.
 *
 * A runtime declaration names which interpreter a workspace runs its tools
 * under, and the version it requires. It is inert data: the constructors
 * validate and perform no I/O, so BUILD.ts evaluation stays pure.
 *
 * The declaration exists because the interpreter is key material. `node -e`
 * and `bun -e` do not evaluate the same program, and two Node versions do not
 * produce the same `tsc` output. Before this module every target spelled `node`
 * into its own argv, which made the interpreter an undeclared ambient fact
 * that no key covered and no BUILD.ts file could change.
 *
 * A declaration is a requirement, not a measurement. `packages/build`
 * carries the matching `Runtime` service, which measures the host interpreter
 * and refuses to execute when it does not satisfy what the workspace declared.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"

/**
 * Schema for the supported JavaScript runtimes.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Name = Schema.Literals(["node", "bun", "deno"])

/**
 * The supported JavaScript runtimes.
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
 * Schema for one declared JavaScript runtime.
 *
 * `version` is the requirement the host is checked against, not a measurement.
 * `executable` is what gets spawned; it defaults to the runtime name and is
 * overridable for hosts that install an interpreter under another name.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Runtime = Schema.TaggedStruct("Runtime", {
  name: Name,
  version: Schema.NonEmptyString,
  executable: Schema.NonEmptyString
})

/**
 * One declared JavaScript runtime.
 *
 * @category models
 * @since 0.1.0
 */
export type Runtime = typeof Runtime.Type

/**
 * Options accepted by every runtime constructor.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  /** The exact version, or version range, the workspace requires. */
  readonly version: string
  /** @default the runtime name */
  readonly executable?: string | undefined
}

const controlCharacter = /[\u0000-\u001f\u007f]/

/**
 * Validates one declared text field.
 *
 * Bounded, well-formed, and control-free are the same three conditions every
 * other declaration in this package applies. A control character in an
 * executable name would reach a child-process argv.
 */
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
 * Creates a declared runtime.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (name: Name, options: Options): Runtime =>
  Runtime.make({
    name,
    version: usable(options.version, "runtime version"),
    executable: options.executable === undefined
      ? name
      : usable(options.executable, "runtime executable")
  })

/**
 * Declares Node as the workspace runtime.
 *
 * @example
 * ```ts
 * import { Smithers } from "@smthrs/targets"
 *
 * export const runtime = Smithers.Runtime.Node({ version: ">=22.19.0" })
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const Node = (options: Options): Runtime => make("node", options)

/**
 * Declares Bun as the workspace runtime.
 *
 * @category constructors
 * @since 0.1.0
 */
export const Bun = (options: Options): Runtime => make("bun", options)

/**
 * Declares Deno as the workspace runtime.
 *
 * @category constructors
 * @since 0.1.0
 */
export const Deno = (options: Options): Runtime => make("deno", options)

/**
 * Checks whether a value is a declared runtime.
 *
 * @category guards
 * @since 0.1.0
 */
export const isRuntime = (value: unknown): value is Runtime => {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as { readonly _tag?: unknown; readonly name?: unknown }
  return candidate._tag === "Runtime" && typeof candidate.name === "string"
}

/**
 * Builds the argv that runs one script under the declared runtime.
 *
 * @category constructors
 * @since 0.1.0
 */
export const run = (runtime: Runtime, args: ReadonlyArray<string>): Array<string> => [
  runtime.executable,
  ...args
]

/**
 * Builds the argv that evaluates one inline program under the declared
 * runtime.
 *
 * The three runtimes spell inline evaluation differently: Node and Bun take
 * `-e`, Deno takes `eval`. A target that needs a throwaway program calls this
 * rather than spelling an interpreter flag into its own argv.
 *
 * @category constructors
 * @since 0.1.0
 */
export const evaluate = (
  runtime: Runtime,
  program: string,
  args: ReadonlyArray<string> = []
): Array<string> =>
  runtime.name === "deno"
    ? [runtime.executable, "eval", program, ...args]
    : [runtime.executable, "-e", program, ...args]

/**
 * The key-material spelling of one declared runtime.
 *
 * A cache key records which interpreter a result was produced under. The
 * spelling is the declared name and version requirement, never a measurement:
 * the requirement is what the workspace stated, and two workspaces that state
 * different requirements must not share a key even when one host satisfies
 * both.
 *
 * @example
 * ```ts
 * import * as Runtime from "@smthrs/targets/Runtime"
 *
 * // "node@>=22.19.0"
 * const material = Runtime.identity(Runtime.Node({ version: ">=22.19.0" }))
 * ```
 *
 * @category keys
 * @since 0.1.0
 */
export const identity = (runtime: Runtime): string => `${runtime.name}@${runtime.version}`
