"""Exposes the vendor/jj git submodule as a Bazel repository.

The pinned jj fork is a git submodule. Files inside a submodule cannot be
tracked by the superproject, so no committed BUILD file can exist inside
vendor/jj, and without a BUILD file no file in the tree is addressable as a
Bazel label. This repository rule bridges the gap: it symlinks the submodule
working tree into an external repository and generates a BUILD file that
exports the tree, making @vendor_jj//:tree usable as action inputs.

Hermeticity note: the tree is read through a symlink to the workspace, which
is exactly what Bazel does for every source file. The submodule is pinned by
the superproject's gitlink, so its content is as stable as any committed
file. After intentionally bumping the submodule, run
`bazel sync --only=vendor_jj` to re-point the repository.
"""

def _impl(rctx):
    src = rctx.workspace_root.get_child("vendor").get_child("jj")
    if not src.get_child("Cargo.toml").exists:
        fail("vendor/jj is not checked out; run `git submodule update --init vendor/jj`")

    # Invalidate when the submodule's manifests change. rctx.watch accepts
    # plain paths, which is how files inside the BUILD-less submodule tree
    # become change inputs.
    rctx.watch(src.get_child("Cargo.toml"))
    rctx.watch(src.get_child("lib").get_child("Cargo.toml"))

    rctx.symlink(src, "jj")
    rctx.file("BUILD.bazel", """
package(default_visibility = ["//visibility:public"])

filegroup(
    name = "tree",
    srcs = glob(["jj/**"]),
)

# Marker used by actions to locate the tree root in the sandbox.
exports_files(["jj/Cargo.toml"])
""")

vendor_jj_repository = repository_rule(
    implementation = _impl,
    local = True,
    doc = "Exposes the vendor/jj submodule working tree as Bazel inputs.",
)
