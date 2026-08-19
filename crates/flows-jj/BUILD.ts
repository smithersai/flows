/**
 * Cargo and wasm verbs for the `flows-jj` crate, declared as `ToolBuild`
 * genrules.
 *
 * Rust is not a build-system subsystem here. `ToolBuild` is already the
 * genrule shape a Rust lane needs — a command, declared inputs, declared
 * outputs, and an explicit cache decision — so the four verbs below are
 * declarations, not a rule. There is one first-party crate; a `Cargo` rule
 * that drove `rustc` per crate would carry a toolchain model no target here
 * would use.
 *
 * The four targets mirror the CI steps one for one:
 * `fmt`, `clippy`, and `test` are the `rust` job's three verbs, and `wasm` is
 * the `wasm-repro` job's rebuild of the committed `flows_jj.wasm`.
 *
 * Every verb runs with `cwd: "."`. Cargo is workspace-rooted: the manifest at
 * the repository root owns `Cargo.lock` and lists this crate as its only
 * member, and `wasm` writes its artifact into `packages/jj/wasm`, which a
 * crate-anchored `cwd` could not name because a declared output may not leave
 * the directory it is declared against.
 *
 * ## Undeclared input: the `vendor/jj` submodule
 *
 * `flows-jj` depends on `jj-lib` through the path dependency
 * `vendor/jj/lib`, a git submodule. Its contents are not declared below, and
 * they cannot be: a glob is package-scoped, so a `//vendor/jj/**` pattern
 * written here expands to nothing. Two consequences follow.
 *
 * 1. `clippy`, `test`, and `wasm` compile `jj-lib`, so their key material is
 *    incomplete and they declare `cache: false`. `fmt` never reads the
 *    submodule — the root workspace excludes `vendor/jj`, so `cargo fmt`
 *    formats this crate's sources alone — and it is cacheable.
 * 2. A future sandbox that projects only declared inputs must still project
 *    `vendor/jj`, or every cargo build inside it fails on a missing
 *    `vendor/jj/lib/Cargo.toml`. Declaring the submodule as a real input is
 *    the fix that removes both problems; it needs a declaration form that
 *    crosses the package boundary.
 *
 * ## No declared outputs on the cargo verbs
 *
 * `fmt`, `clippy`, and `test` produce only `target/`. Output capture digests
 * every file under a declared root and refuses a symbolic link anywhere in
 * the tree, and cargo's target directory holds both a large object graph and
 * links. Declaring it would cost more than it proves, so these three declare
 * no outputs and are judged by their exit status.
 *
 * @since 0.1.0
 */
import { Smithers } from "@smthrs/targets"

/**
 * Every source the crate compiles from, plus the two root files that pin what
 * compiles it. `Cargo.lock` fixes the dependency versions and
 * `rust-toolchain.toml` fixes the compiler, the components, and the
 * `wasm32-wasip1` target, so a change to either changes the result of every
 * verb below.
 */
const sources = [
  Smithers.glob("src/**/*.rs"),
  Smithers.glob("tests/**/*.rs"),
  Smithers.file("Cargo.toml"),
  Smithers.file("//Cargo.lock"),
  Smithers.file("//rust-toolchain.toml")
]

/**
 * Checks Rust formatting. `ci.yml`'s `Format` step.
 *
 * @since 0.1.0
 * @category build
 */
export const fmt = Smithers.ToolBuild({
  tool: "cargo",
  command: "cargo",
  args: ["fmt", "--check"],
  inputs: sources,
  outputs: [],
  deps: [],
  env: {},
  cache: true,
  cwd: "."
})

/**
 * Lints every target of the crate and fails on any warning. `ci.yml`'s
 * `Clippy` step.
 *
 * @since 0.1.0
 * @category build
 */
export const clippy = Smithers.ToolBuild({
  tool: "cargo",
  command: "cargo",
  args: ["clippy", "--all-targets", "--locked", "--", "-D", "warnings"],
  inputs: sources,
  outputs: [],
  deps: [],
  env: {},
  cache: false,
  cwd: "."
})

/**
 * Runs the native test suite against the committed lockfile. `ci.yml`'s
 * `Test` step.
 *
 * @since 0.1.0
 * @category build
 */
export const test = Smithers.ToolBuild({
  tool: "cargo",
  command: "cargo",
  args: ["test", "--locked"],
  inputs: sources,
  outputs: [],
  deps: [],
  env: {},
  cache: false,
  cwd: "."
})

/**
 * Rebuilds `packages/jj/wasm/flows_jj.wasm` from source with the pinned
 * toolchain. `ci.yml`'s `wasm-repro` job.
 *
 * `cache: false` is the point of the target. The committed artifact is a
 * reproducibility contract, and the rebuild is what checks it; a cache hit
 * would report the check green without ever running it. `build-wasm.mjs`
 * refuses to build on a host other than `x86_64-unknown-linux-gnu` and prints
 * the container command, so the target fails loudly off that host rather than
 * writing bytes CI cannot match.
 *
 * @since 0.1.0
 * @category build
 */
export const wasm = Smithers.ToolBuild({
  tool: "node",
  command: "node",
  args: ["crates/flows-jj/build-wasm.mjs"],
  inputs: [...sources, Smithers.file("build-wasm.mjs")],
  outputs: ["packages/jj/wasm/flows_jj.wasm"],
  deps: [],
  env: {},
  cache: false,
  cwd: "."
})
