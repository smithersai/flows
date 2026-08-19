#!/bin/bash
# Re-derives one instance's model patch from its surviving workspace, without
# re-running the agent. Use after changing what the diff excludes.
#
#   regen-patch.sh <instance_id>
set -u
S="$(cd "$(dirname "$0")" && pwd)"
INSTANCE="$1"
DATASET="${SWB_DATASET:-$S/swb-verified.json}"
BASE="$(node -e '
const fs=require("fs");
const all=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
process.stdout.write(all.find(r=>r.instance_id===process.argv[2]).base_commit);
' "$DATASET" "$INSTANCE")"
( cd "$S/work/$INSTANCE" && git -c core.fileMode=false --no-pager diff "$BASE" -- \
    ':(exclude)flows' ':(exclude).flows' ':(exclude).jj' \
    ':(exclude)*.pyc' ':(exclude)**/__pycache__/**' ':(exclude).git' \
) > "$S/patches/$INSTANCE.patch" 2>/dev/null
node "$S/lib/strip-modes.mjs" "$S/patches/$INSTANCE.patch"
echo "$INSTANCE $(wc -c < "$S/patches/$INSTANCE.patch" | tr -d ' ') bytes"
