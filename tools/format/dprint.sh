#!/usr/bin/env bash
# Runs dprint once per Bazel-wired package, from the package directory, so the
# package's own dprint.json applies. $1 is the dprint command (fmt or check).
set -euo pipefail

self_dir="$(cd "$(dirname "$0")" && pwd)"
self_name="$(basename "$0")"
runfiles="${RUNFILES_DIR:-$self_dir/$self_name.runfiles}"
# sh_binary launchers are named <target> or <target>.bash depending on platform.
[ -d "$runfiles" ] || runfiles="$self_dir/${self_name%.bash}.runfiles"
[ -d "$runfiles" ] || runfiles="$self_dir/${self_name}.bash.runfiles"
dprint="$runfiles/_main/tools/format/dprint_/dprint"
root="${BUILD_WORKSPACE_DIRECTORY:-$PWD}"

status=0
for pkg in canonical crypto keys; do
  (cd "$root/packages/$pkg" && BAZEL_BINDIR=. "$dprint" "$1") || status=$?
done
exit "$status"
