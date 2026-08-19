/**
 * Cargo gates as declared targets.
 *
 * The three checks a Rust workspace gates on — `cargo fmt --check`,
 * `cargo clippy`, and `cargo test` — were shell strings in a BUILD.ts file
 * until this module existed. Each is now a declaration whose argv the
 * implementation renders, on the same terms as every other target: the flags
 * that make a check a gate rather than a fixer live here, not at the call site.
 *
 * There are two target types rather than one because a target's participating
 * verbs are fixed by its type, not by its attrs: the planner selects by kind, so
 * one type covering both verbs would put `cargo fmt` in the graph of
 * `smthrs test`. {@link CargoLint} is the lint gate and {@link CargoTest} is the
 * test gate, and each takes only the checks that belong to its verb.
 *
 * Bazel's `rules_rust` models the same gates as `rustfmt_test`, `rust_clippy`,
 * and `rust_test`, one rule apiece. The deviation here is the check union: all
 * three run the same executable over the same declared crate sources and differ
 * only in argv, so the split is one level down, in the discriminated union each
 * target takes.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Exec from "./Exec.ts"
import * as Input from "./Input.ts"
import * as RustToolchain from "./RustToolchain.ts"
import * as Target from "./Target.ts"

/**
 * Schema for a `cargo fmt --check` gate.
 *
 * There is no "fix" option: a formatter that rewrites the tree is not a gate,
 * and a target that could be either would make every declaration a question
 * about which one it is.
 *
 * @category schemas
 * @since 0.1.0
 */
export const FmtCheck = Schema.Struct({ name: Schema.Literal("fmt") })

/**
 * A `cargo fmt --check` gate.
 *
 * @category models
 * @since 0.1.0
 */
export type FmtCheck = typeof FmtCheck.Type

/**
 * Schema for a `cargo clippy` gate.
 *
 * @category schemas
 * @since 0.1.0
 */
export const ClippyCheck = Schema.Struct({
  name: Schema.Literal("clippy"),
  /** Lint tests, benches, and examples too, not just the library targets. */
  allTargets: Schema.Boolean,
  /** Refuse to update `Cargo.lock`, so the gate's result does not depend on when it ran. */
  locked: Schema.Boolean,
  /** Promote every warning to an error, which is what makes clippy a gate. */
  denyWarnings: Schema.Boolean
})

/**
 * A `cargo clippy` gate.
 *
 * @category models
 * @since 0.1.0
 */
export type ClippyCheck = typeof ClippyCheck.Type

/**
 * Schema for a `cargo test` gate.
 *
 * @category schemas
 * @since 0.1.0
 */
export const TestCheck = Schema.Struct({
  name: Schema.Literal("test"),
  /** Refuse to update `Cargo.lock`. */
  locked: Schema.Boolean
})

/**
 * A `cargo test` gate.
 *
 * @category models
 * @since 0.1.0
 */
export type TestCheck = typeof TestCheck.Type

/**
 * Schema for one declared cargo lint gate.
 *
 * @category schemas
 * @since 0.1.0
 */
export const LintCheck = Schema.Union([FmtCheck, ClippyCheck])

/**
 * One declared cargo lint gate.
 *
 * @category models
 * @since 0.1.0
 */
export type LintCheck = typeof LintCheck.Type

/**
 * Declares the `cargo fmt --check` gate.
 *
 * @example
 * ```ts
 * import { Smithers } from "@smthrs/targets"
 *
 * export const check = Smithers.Cargo.Fmt()
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const Fmt = (): FmtCheck => FmtCheck.make({ name: "fmt" })

/**
 * Declares the `cargo clippy` gate.
 *
 * The defaults are the gate form: every target, a frozen lockfile, and warnings
 * as errors. A declaration that wants less has to say so.
 *
 * @category constructors
 * @since 0.1.0
 */
export const Clippy = (options: {
  /** @default true */
  readonly allTargets?: boolean | undefined
  /** @default true */
  readonly locked?: boolean | undefined
  /** @default true */
  readonly denyWarnings?: boolean | undefined
} = {}): ClippyCheck =>
  ClippyCheck.make({
    name: "clippy",
    allTargets: options.allTargets ?? true,
    locked: options.locked ?? true,
    denyWarnings: options.denyWarnings ?? true
  })

/**
 * Declares the `cargo test` gate.
 *
 * @category constructors
 * @since 0.1.0
 */
export const Test = (options: {
  /** @default true */
  readonly locked?: boolean | undefined
} = {}): TestCheck => TestCheck.make({ name: "test", locked: options.locked ?? true })

/**
 * Attributes shared by {@link CargoLint} and {@link CargoTest}.
 *
 * `cwd` is the workspace-relative directory cargo runs in and defaults to the
 * workspace root, so a crate inside a cargo workspace is checked from the root
 * that owns `Cargo.lock`.
 *
 * @category schemas
 * @since 0.1.0
 */
const common = {
  toolchain: RustToolchain.RustToolchain,
  /** Crate sources, manifests, and the lockfile, digested as key material. */
  srcs: Schema.Array(Input.Declared),
  deps: Schema.Array(Target.Target),
  cwd: Schema.NonEmptyString.pipe(Schema.withConstructorDefault(Effect.succeed(".")))
}

/**
 * Attributes for {@link CargoLint}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const LintAttrs = Schema.Struct({ ...common, check: LintCheck })

/**
 * Attributes for {@link CargoLint}.
 *
 * @category models
 * @since 0.1.0
 */
export type LintAttrs = typeof LintAttrs.Type

/**
 * Attributes for {@link CargoTest}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const TestAttrs = Schema.Struct({ ...common, check: TestCheck })

/**
 * Attributes for {@link CargoTest}.
 *
 * @category models
 * @since 0.1.0
 */
export type TestAttrs = typeof TestAttrs.Type

/**
 * Builds the gate argv from decoded attrs at plan time.
 *
 * `--` separates cargo's own options from the ones clippy forwards to rustc,
 * which is where `-D warnings` has to go: passed before it, cargo reads it as
 * one of its own and rejects it.
 *
 * @category rendering
 * @since 0.1.0
 */
export const checkArgv = (
  toolchain: RustToolchain.RustToolchain,
  check: LintCheck | TestCheck
): ReadonlyArray<string> => {
  switch (check.name) {
    case "fmt":
      return RustToolchain.cargo(toolchain, ["fmt", "--check"])
    case "clippy":
      return RustToolchain.cargo(toolchain, [
        "clippy",
        ...(check.allTargets ? ["--all-targets"] : []),
        ...(check.locked ? ["--locked"] : []),
        ...(check.denyWarnings ? ["--", "-D", "warnings"] : [])
      ])
    case "test":
      return RustToolchain.cargo(toolchain, ["test", ...(check.locked ? ["--locked"] : [])])
  }
}

/**
 * Runs one declared cargo lint gate.
 *
 * The plan runs cargo in `cwd` through the shared {@link Exec.Exec} action.
 * Success carries the {@link Exec.Result} run summary; the target declares no
 * output directories, because a gate's product is its exit code. Crate sources
 * and the toolchain declaration are the key material, so a gate re-runs when the
 * sources move or the pin changes and not otherwise. Executing the plan requires
 * {@link Exec.ExecLive} and a host with the declared toolchain installed.
 *
 * @category targets
 * @since 0.1.0
 */
export const CargoLint = Target.make("CargoLint", {
  attrs: LintAttrs,
  kinds: ["lint"],
  success: Exec.Result,
  error: Exec.ExecError,
  implementation: (attrs) => Target.runTool({ cwd: attrs.cwd, argv: checkArgv(attrs.toolchain, attrs.check) })
})

/**
 * Runs the declared `cargo test` gate.
 *
 * The same shape as {@link CargoLint}, under the test verb.
 *
 * @category targets
 * @since 0.1.0
 */
export const CargoTest = Target.make("CargoTest", {
  attrs: TestAttrs,
  kinds: ["test"],
  success: Exec.Result,
  error: Exec.ExecError,
  implementation: (attrs) => Target.runTool({ cwd: attrs.cwd, argv: checkArgv(attrs.toolchain, attrs.check) })
})
