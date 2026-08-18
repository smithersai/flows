#!/usr/bin/env bash
# Runs one cargo command for the flows-jj crate inside a Bazel action.
#
# Why this exists: the idiomatic rules_rust path (crate_universe over
# Cargo.lock) cannot render this dependency graph — cargo-bazel's splicer
# needs every manifest as a Bazel label, and the pinned jj fork is a git
# submodule whose tree cannot carry committed BUILD files. The details are in
# docs/build-systems/bazel.md. This script is the bridge: it reconstructs the
# workspace layout in a scratch directory from declared inputs and runs the
# pinned (rust-toolchain.toml) cargo with an offline, lockfile-verified
# registry.
#
# Required environment (wired by the genrule/sh_test in
# //crates/flows-jj/BUILD.bazel):
#   ROOT_MANIFEST     execpath of the root Cargo.toml
#   LOCKFILE          execpath of the root Cargo.lock
#   TOOLCHAIN_FILE    execpath of rust-toolchain.toml
#   CRATE_MANIFEST    execpath of crates/flows-jj/Cargo.toml
#   VENDOR_MANIFEST   execpath of @vendor_jj//:jj/Cargo.toml
#   REGISTRY_MARKER   execpath of @cargo_registry//:cargo-home/BAZEL_MARKER
#
# $1 is the mode: build-wasm | test | fmt | clippy
# $2 (build-wasm only) is the output path for flows_jj.wasm.
set -euo pipefail

# The rustup shims are not on the sandbox's strict PATH.
export PATH="$HOME/.cargo/bin:$PATH"

mode="$1"
out="${2:-}"
# Bazel passes the output path relative to the execroot; absolutize before cd.
if [ -n "$out" ]; then
  out="$(cd "$(dirname "$out")" && pwd)/$(basename "$out")"
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/flows-cargo.XXXXXX")"
trap 'rm -rf "$work"' EXIT

# Action inputs are symlinks to the real files; resolve through them and
# symlink the real directories into the scratch workspace so cargo sees the
# exact relative layout the path dependency expects (crates/flows-jj next to
# vendor/jj) without any writable access to the real tree.
#
# Build actions address external repos as external/<canonical>/... from the
# execroot; test runfiles place them as <canonical>/... next to _main under
# TEST_SRCDIR. resolve_input accepts both layouts.
resolve_input() {
  if [ -e "$1" ]; then
    printf '%s' "$1"
  elif [ -n "${TEST_SRCDIR:-}" ] && [ -e "$TEST_SRCDIR/${1#external/}" ]; then
    printf '%s' "$TEST_SRCDIR/${1#external/}"
  else
    echo "input not found: $1" >&2
    exit 1
  fi
}

resolve_dir() { cd "$(dirname "$(resolve_input "$1")")" && pwd -P; }

mkdir -p "$work/crates" "$work/vendor" "$work/cargo-home/registry"
ln -s "$(resolve_dir "$ROOT_MANIFEST")/Cargo.toml" "$work/Cargo.toml"
ln -s "$(resolve_dir "$LOCKFILE")/Cargo.lock" "$work/Cargo.lock"
ln -s "$(resolve_dir "$TOOLCHAIN_FILE")/rust-toolchain.toml" "$work/rust-toolchain.toml"
ln -s "$(resolve_dir "$CRATE_MANIFEST")" "$work/crates/flows-jj"
ln -s "$(resolve_dir "$VENDOR_MANIFEST")" "$work/vendor/jj"

registry_home="$(resolve_dir "$REGISTRY_MARKER")"
ln -s "$registry_home/registry/cache" "$work/cargo-home/registry/cache"
if [ -d "$registry_home/registry/index" ]; then
  ln -s "$registry_home/registry/index" "$work/cargo-home/registry/index"
fi

export CARGO_HOME="$work/cargo-home"
export CARGO_TARGET_DIR="$work/target"

cd "$work"

case "$mode" in
  build-wasm)
    sysroot="$(rustc --print sysroot)"
    commit_hash="$(rustc -vV | sed -n 's/^commit-hash: //p')"
    # Mirrors crates/flows-jj/build-wasm.mjs remapFlags exactly: the scratch
    # workspace stands in for the checkout (/flows), the action's CARGO_HOME
    # for the user's cargo home (/cargo), and the std-source prefix for the
    # toolchain's /rustc/<commit-hash> form. Same tokens, same order, so the
    # bytes are comparable to the committed artifact on the canonical host.
    export RUSTFLAGS="--remap-path-prefix=$work/cargo-home=/cargo --remap-path-prefix=$work=/flows --remap-path-prefix=$sysroot/lib/rustlib/src/rust=/rustc/$commit_hash"
    unset CARGO_ENCODED_RUSTFLAGS
    cargo build --locked --offline -p flows-jj --lib --release --target wasm32-wasip1
    cp "$work/target/wasm32-wasip1/release/flows_jj.wasm" "$out"
    ;;
  test)
    cargo test --locked --offline -p flows-jj
    ;;
  fmt)
    cargo fmt --check -p flows-jj
    ;;
  clippy)
    cargo clippy --locked --offline -p flows-jj --all-targets -- -D warnings
    ;;
  *)
    echo "unknown mode: $mode" >&2
    exit 2
    ;;
esac
