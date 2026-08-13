/**
 * Builds `flows_jj.wasm` — the wasm32-wasip1 reactor module behind
 * `BrowserJj` — and copies it to `packages/jj/wasm/flows_jj.wasm`.
 *
 * The Rust side lives in this crate (`crates/flows-jj`), which depends on the
 * patched jj fork at `vendor/jj`. The build runs through the repo-root Cargo
 * workspace so native tests and the wasm artifact share one lockfile, and it
 * builds `--locked` so the artifact always reflects the committed Cargo.lock.
 *
 * The committed artifact is a reproducibility contract: CI rebuilds it with
 * the toolchain pinned in `rust-toolchain.toml` and fails on any byte drift.
 * rustc embeds source paths in panic locations, so the build remaps every
 * machine-specific prefix — the repository checkout, `CARGO_HOME`, and the
 * toolchain sysroot — to fixed tokens. Without the remapping, the same
 * commit produces different bytes on every machine and checkout path.
 *
 * Honors `CARGO_TARGET_DIR`; a relative value resolves against the workspace
 * root, exactly as cargo resolves it for the build itself.
 *
 * Run it from anywhere: `node crates/flows-jj/build-wasm.mjs`.
 * Prerequisite: rustup — `rust-toolchain.toml` supplies the toolchain,
 * the `wasm32-wasip1` target, and the components.
 */
import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..", "..")

/**
 * The cargo target directory: `CARGO_TARGET_DIR` when set, the workspace
 * default otherwise. Cargo resolves a relative `CARGO_TARGET_DIR` against
 * its invocation directory, which for this build is the workspace root.
 */
export const targetDir = (env, workspaceRoot) =>
  env.CARGO_TARGET_DIR !== undefined && env.CARGO_TARGET_DIR !== ""
    ? resolve(workspaceRoot, env.CARGO_TARGET_DIR)
    : join(workspaceRoot, "target")

/** The `commit-hash` line of `rustc -vV`, the token std paths are keyed on. */
export const rustcCommitHash = (verboseVersion) => {
  const match = verboseVersion.match(/^commit-hash: ([0-9a-f]+)$/m)
  if (match === null) {
    throw new Error(`rustc -vV output has no commit-hash line:\n${verboseVersion}`)
  }
  return match[1]
}

/**
 * `--remap-path-prefix` flags that replace every machine-specific source
 * prefix with a fixed token, so the artifact's bytes do not depend on where
 * the repository, the cargo registry, or the toolchain happen to live.
 *
 * The sysroot's `rust-src` layout maps back to `/rustc/<commit-hash>` — the
 * token prebuilt std paths already carry — so a toolchain with `rust-src`
 * installed (rustc rewrites std spans to local paths when it is) produces
 * the same bytes as the minimal toolchain CI installs.
 */
export const remapFlags = ({ cargoHome, commitHash, sysroot, workspaceRoot }) => [
  `--remap-path-prefix=${workspaceRoot}=/flows`,
  `--remap-path-prefix=${cargoHome}=/cargo`,
  `--remap-path-prefix=${join(sysroot, "lib", "rustlib", "src", "rust")}=/rustc/${commitHash}`
]

const isMain = process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (isMain) {
  const artifact = join(targetDir(process.env, repoRoot), "wasm32-wasip1", "release", "flows_jj.wasm")
  const destinationDir = join(repoRoot, "packages", "jj", "wasm")
  const destination = join(destinationDir, "flows_jj.wasm")

  const rustc = (args) => {
    const result = spawnSync("rustc", args, { cwd: repoRoot, encoding: "utf8" })
    if (result.error?.code === "ENOENT") {
      console.error("error: `rustc` not found on PATH — install a Rust toolchain (rustup) first")
      process.exit(1)
    }
    if (result.status !== 0) {
      console.error(result.stderr ?? "")
      console.error(`error: rustc ${args.join(" ")} failed`)
      process.exit(result.status ?? 1)
    }
    return result.stdout
  }

  const flags = remapFlags({
    cargoHome: process.env.CARGO_HOME ?? join(homedir(), ".cargo"),
    commitHash: rustcCommitHash(rustc(["-vV"])),
    sysroot: rustc(["--print", "sysroot"]).trim(),
    workspaceRoot: repoRoot
  })

  const build = spawnSync(
    "cargo",
    ["build", "--locked", "--release", "--target", "wasm32-wasip1", "--package", "flows-jj"],
    {
      cwd: repoRoot,
      // RUSTFLAGS applies to wasm32-wasip1 units only (cargo exempts host
      // units when --target is passed), so proc macros build untouched.
      env: { ...process.env, RUSTFLAGS: [process.env.RUSTFLAGS, ...flags].filter(Boolean).join(" ") },
      stdio: "inherit"
    }
  )
  if (build.error?.code === "ENOENT") {
    console.error("error: `cargo` not found on PATH — install a Rust toolchain (rustup) first")
    process.exit(1)
  }
  if (build.status !== 0) {
    console.error(
      "error: cargo build failed" +
        " — if the target is missing, run `rustup target add wasm32-wasip1`"
    )
    process.exit(build.status ?? 1)
  }

  mkdirSync(destinationDir, { recursive: true })
  copyFileSync(artifact, destination)
  const { size } = statSync(destination)
  console.log(`built ${destination} (${(size / 1024 / 1024).toFixed(2)} MiB)`)
}
