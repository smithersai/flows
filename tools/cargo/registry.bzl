"""An offline crates.io registry for the flows Cargo workspace.

Runs `cargo fetch --locked` at repository-fetch time (where network access is
legitimate) and exposes the resulting CARGO_HOME as action inputs. Build and
test actions then run cargo with CARGO_NET_OFFLINE=true: every crate archive
is a declared, hash-checked input (cargo verifies each archive against the
sha256 recorded in the committed Cargo.lock), and no action touches the
network.

The registry is keyed on the committed Cargo.lock: any lockfile change
re-runs the fetch.
"""

def _impl(rctx):
    cargo = rctx.which("cargo")
    if cargo == None:
        fail("cargo not found on PATH; install rustup (rust-toolchain.toml pins the toolchain)")

    lockfile = rctx.path(rctx.attr.lockfile)
    rctx.watch(lockfile)

    home = rctx.path("cargo-home")
    result = rctx.execute(
        [cargo, "fetch", "--locked", "--manifest-path", rctx.path(rctx.attr.manifest)],
        environment = {"CARGO_HOME": str(home)},
        quiet = False,
    )
    if result.return_code != 0:
        fail("cargo fetch failed: " + result.stderr)

    rctx.file("cargo-home/BAZEL_MARKER", "cargo fetch --locked output\n")
    rctx.file("BUILD.bazel", """
package(default_visibility = ["//visibility:public"])

filegroup(
    name = "registry",
    srcs = glob(["cargo-home/**"]),
)

# Marker used by actions to locate the registry root in the sandbox.
exports_files(["cargo-home/BAZEL_MARKER"])
""")

cargo_registry_repository = repository_rule(
    implementation = _impl,
    attrs = {
        "lockfile": attr.label(default = "//:Cargo.lock"),
        "manifest": attr.label(default = "//:Cargo.toml"),
    },
    doc = "Fetches every crate in Cargo.lock into an offline CARGO_HOME.",
)
