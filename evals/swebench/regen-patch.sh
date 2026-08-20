#!/bin/bash
# Re-derives one instance's model patch from its surviving workspace, without
# re-running the agent. Use after changing what the diff excludes.
#
#   regen-patch.sh <instance_id>
set -euo pipefail
S="$(cd "$(dirname "$0")" && pwd)"
INSTANCE="${1:-}"
DATASET="${SWB_DATASET:-$S/swb-verified.json}"
BASE="$(node "$S/lib/validate-instance.mjs" "$DATASET" "$INSTANCE")" || exit $?
mkdir -p "$S/work" "$S/patches"
WORK_ROOT="$(cd "$S/work" && pwd -P)"
WORK="$(node -e 'process.stdout.write(require("node:path").resolve(process.argv[1], process.argv[2]))' "$WORK_ROOT" "$INSTANCE")"
if [ "$(dirname "$WORK")" != "$WORK_ROOT" ]; then
  echo "[$INSTANCE] resolved work path escaped $WORK_ROOT"; exit 2
fi
( cd "$WORK" && git -c core.fileMode=false --no-pager diff "$BASE" -- \
    ':(exclude)flows' ':(exclude).flows' ':(exclude).jj' \
    ':(exclude)*.pyc' ':(exclude)**/__pycache__/**' ':(exclude).git' \
) > "$S/patches/$INSTANCE.patch" 2>/dev/null
node "$S/lib/strip-modes.mjs" "$S/patches/$INSTANCE.patch"
echo "$INSTANCE $(wc -c < "$S/patches/$INSTANCE.patch" | tr -d ' ') bytes"
