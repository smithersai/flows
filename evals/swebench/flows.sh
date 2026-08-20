#!/bin/bash
# Runs this checkout's flows CLI against the caller's working directory.
#
#   flows.sh [--json] <verb> [args...]
#
# The benchmark drives the CLI from an extracted SWE-bench testbed, which is an
# arbitrary directory outside this repository. The CLI reads its project flows
# from the working directory (`<cwd>/flows/<name>/flow.mdx`) and keeps its
# control database in `<cwd>/.flows`, so the wrapper changes no directory: it
# only resolves the executable out of the checkout and execs it in place.
#
# `packages/cli/dist/esm/bin.js` is the published `flows` binary's entry point.
# It is a build artifact and gitignored, so a fresh checkout has none; the
# wrapper builds the package once when it is missing. Set FLOWS_CLI_REBUILD=1 to
# rebuild it even when it exists, which is what to do after editing CLI sources.
set -u
S="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$S/../.." && pwd)"
BIN="$ROOT/packages/cli/dist/esm/bin.js"

if [ ! -f "$BIN" ] || [ "${FLOWS_CLI_REBUILD:-0}" = "1" ]; then
  echo "flows.sh: building @smthrs/cli" >&2
  ( cd "$ROOT" && pnpm --filter @smthrs/cli build ) >&2 || {
    echo "flows.sh: build failed; cannot run the CLI" >&2; exit 1; }
fi

exec node "$BIN" "$@"
