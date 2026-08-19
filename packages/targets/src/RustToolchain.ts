/**
 * Declared Rust toolchain for BUILD.ts targets.
 *
 * A Rust toolchain declaration names how a workspace obtains `rustc` and
 * `cargo`, and where the pin that fixes their version lives. It is inert data:
 * the constructors validate and perform no I/O, so BUILD.ts evaluation stays
 * pure.
 *
 * The declaration exists for the same reason {@link Runtime} does. Before it,
 * the only way to say "CI installs the pinned Rust toolchain and then runs
 * clippy" was a pair of shell strings in a BUILD.ts file, which put an argv
 * outside every target implementation and left the toolchain undeclared key
 * material. A declaration makes the pin a value: {@link CargoCheck} takes it as
 * an attr and asks this module for the argv, and the CI generator derives its
 * bootstrap step from the same value.
 *
 * The declaration is a discriminated union, one variant per way of obtaining a
 * toolchain, discriminated by `name`. Only `pinned` exists today: `rustup`
 * reads `rust-toolchain.toml` and installs exactly what it pins, components and
 * targets included, so the pin cannot drift from what runs. A workspace that
 * needs a channel it does not pin adds a variant here, which is the point — the
 * set of toolchains a BUILD.ts file may declare is reviewed, not free text.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"

/**
 * Schema for the supported ways of obtaining a Rust toolchain.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Name = Schema.Literals(["pinned"])

/**
 * The supported ways of obtaining a Rust toolchain.
 *
 * @category models
 * @since 0.1.0
 */
export type Name = typeof Name.Type

/**
 * Maximum length of a declared executable or pin path.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumTextLength = 256

/**
 * Schema for a toolchain obtained from a checked-in `rustup` pin.
 *
 * `pin` is the workspace-relative file `rustup` reads. It is declared rather
 * than assumed so the pin is key material: a target keyed on this declaration
 * is keyed on which file fixes the compiler it ran.
 *
 * @category schemas
 * @since 0.1.0
 */
export const PinnedRustToolchain = Schema.Struct({
  name: Schema.Literal("pinned"),
  pin: Schema.NonEmptyString,
  rustup: Schema.NonEmptyString,
  cargo: Schema.NonEmptyString
})

/**
 * One toolchain obtained from a checked-in `rustup` pin.
 *
 * @category models
 * @since 0.1.0
 */
export type PinnedRustToolchain = typeof PinnedRustToolchain.Type

/**
 * Schema for one declared Rust toolchain.
 *
 * @category schemas
 * @since 0.1.0
 */
export const RustToolchain = Schema.Union([PinnedRustToolchain])

/**
 * One declared Rust toolchain.
 *
 * @category models
 * @since 0.1.0
 */
export type RustToolchain = typeof RustToolchain.Type

/**
 * Options accepted by {@link Pinned}.
 *
 * @category models
 * @since 0.1.0
 */
export interface PinnedOptions {
  /** @default "rust-toolchain.toml" */
  readonly pin?: string | undefined
  /** @default "rustup" */
  readonly rustup?: string | undefined
  /** @default "cargo" */
  readonly cargo?: string | undefined
}

const controlCharacter = /[\u0000-\u001f\u007f]/

/**
 * Validates one declared text field.
 *
 * Bounded, well-formed, and control-free are the same three conditions every
 * other declaration in this package applies, and for the same reason: a control
 * character in an executable name would reach a child-process argv.
 */
const usable = (value: unknown, what: string): string => {
  if (typeof value !== "string") throw new TypeError(`${what} must be a string`)
  if (
    value.length > maximumTextLength ||
    !value.isWellFormed() ||
    controlCharacter.test(value)
  ) throw new Error(`${what} must be bounded well-formed text without control characters`)
  const trimmed = value.trim()
  if (trimmed === "") throw new Error(`${what} must not be empty`)
  return trimmed
}

/**
 * Declares the toolchain a checked-in `rustup` pin fixes.
 *
 * @example
 * ```ts
 * import { Smithers } from "@smthrs/targets"
 *
 * export const rust = Smithers.RustToolchain.Pinned({})
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const Pinned = (options: PinnedOptions = {}): PinnedRustToolchain =>
  PinnedRustToolchain.make({
    name: "pinned",
    pin: options.pin === undefined ? "rust-toolchain.toml" : usable(options.pin, "rust toolchain pin"),
    rustup: options.rustup === undefined ? "rustup" : usable(options.rustup, "rustup executable"),
    cargo: options.cargo === undefined ? "cargo" : usable(options.cargo, "cargo executable")
  })

/**
 * Checks whether a value is a declared Rust toolchain.
 *
 * The guard is the schema itself, so it admits exactly the values a
 * constructor can produce.
 *
 * @category guards
 * @since 0.1.0
 */
export const isRustToolchain: (value: unknown) => value is RustToolchain = Schema.is(RustToolchain)

/**
 * Builds the argv that installs the declared toolchain.
 *
 * A bare `rustup toolchain install` reads the pin, so the components and
 * targets the pin names are installed with it and nothing restates them.
 *
 * @category constructors
 * @since 0.1.0
 */
export const install = (toolchain: RustToolchain): Array<string> => [toolchain.rustup, "toolchain", "install"]

/**
 * Builds the argv that runs one cargo subcommand under the declared toolchain.
 *
 * @category constructors
 * @since 0.1.0
 */
export const cargo = (toolchain: RustToolchain, args: ReadonlyArray<string>): Array<string> => [
  toolchain.cargo,
  ...args
]
