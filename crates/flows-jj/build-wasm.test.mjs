import assert from "node:assert/strict"
import { join, resolve } from "node:path"
import test from "node:test"
import { remapFlags, rustcCommitHash, targetDir } from "./build-wasm.mjs"

test("targetDir defaults to the workspace target directory", () => {
  assert.equal(targetDir({}, "/repo"), join("/repo", "target"))
})

test("targetDir treats an empty CARGO_TARGET_DIR as unset", () => {
  assert.equal(targetDir({ CARGO_TARGET_DIR: "" }, "/repo"), join("/repo", "target"))
})

test("targetDir honors an absolute CARGO_TARGET_DIR", () => {
  const absolute = resolve("/tmp", "flows-ci-target")
  assert.equal(targetDir({ CARGO_TARGET_DIR: absolute }, "/repo"), absolute)
})

test("targetDir resolves a relative CARGO_TARGET_DIR against the workspace root, like cargo", () => {
  assert.equal(
    targetDir({ CARGO_TARGET_DIR: "ci-target" }, "/repo"),
    resolve("/repo", "ci-target")
  )
})

test("rustcCommitHash extracts the commit-hash line of rustc -vV", () => {
  const verboseVersion = [
    "rustc 1.89.0 (29483883e 2025-08-04)",
    "binary: rustc",
    "commit-hash: 29483883eed69d5fb4db01964cdf2af4d86e9cb2",
    "commit-date: 2025-08-04",
    "host: aarch64-apple-darwin",
    "release: 1.89.0",
    "LLVM version: 20.1.7"
  ].join("\n")
  assert.equal(rustcCommitHash(verboseVersion), "29483883eed69d5fb4db01964cdf2af4d86e9cb2")
})

test("rustcCommitHash rejects output without a commit-hash line", () => {
  assert.throws(() => rustcCommitHash("rustc 1.89.0"), /commit-hash/)
})

test("remapFlags replaces every machine-specific prefix with a fixed token", () => {
  assert.deepEqual(
    remapFlags({
      cargoHome: "/home/user/.cargo",
      commitHash: "abc123",
      sysroot: "/home/user/.rustup/toolchains/1.89.0-x86_64-unknown-linux-gnu",
      workspaceRoot: "/home/user/flows"
    }),
    [
      "--remap-path-prefix=/home/user/flows=/flows",
      "--remap-path-prefix=/home/user/.cargo=/cargo",
      "--remap-path-prefix=" +
        join(
          "/home/user/.rustup/toolchains/1.89.0-x86_64-unknown-linux-gnu",
          "lib",
          "rustlib",
          "src",
          "rust"
        ) +
        "=/rustc/abc123"
    ]
  )
})
