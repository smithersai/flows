/**
 * Builds `flows_jj.wasm` — the wasm32-wasip1 reactor module behind
 * `BrowserJj` — and copies it to `packages/jj/wasm/flows_jj.wasm`.
 *
 * The Rust side lives in this crate (`crates/flows-jj`), which depends on the
 * patched jj fork at `vendor/jj`. The build runs through the repo-root Cargo
 * workspace so native tests and the wasm artifact share one lockfile.
 *
 * Run it from anywhere: `node crates/flows-jj/build-wasm.mjs`.
 * Prerequisite: `rustup target add wasm32-wasip1`.
 */
import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..", "..")
const artifact = join(repoRoot, "target", "wasm32-wasip1", "release", "flows_jj.wasm")
const destinationDir = join(repoRoot, "packages", "jj", "wasm")
const destination = join(destinationDir, "flows_jj.wasm")

const build = spawnSync(
  "cargo",
  ["build", "--release", "--target", "wasm32-wasip1", "--package", "flows-jj"],
  { cwd: repoRoot, stdio: "inherit" }
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
