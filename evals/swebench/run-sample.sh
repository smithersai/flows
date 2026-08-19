#!/bin/bash
# Runs one harness over every instance in the seeded sample, in draw order.
#
#   run-sample.sh [flows|codex] [count] [timeout-seconds]
#
# Sequential on purpose: each instance holds a multi-GB extracted testbed and a
# live container, and the extraction lock serializes the expensive step anyway.
set -u
S="$(cd "$(dirname "$0")" && pwd)"
HARNESS="${1:-flows}"
COUNT="${2:-5}"
BUDGET="${3:-}"

if [ ! -f "$S/sample.json" ]; then
  echo "no sample at $S/sample.json — run ./bootstrap.sh first"; exit 1
fi

IDS="$(node -e '
const fs=require("fs");
const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
process.stdout.write(s.instances.slice(0,Number(process.argv[2])).join(" "));
' "$S/sample.json" "$COUNT")"

for ID in $IDS; do
  if [ "$HARNESS" = "codex" ]; then
    "$S/run-instance-codex.sh" "$ID" ${BUDGET:+"$BUDGET"}
  else
    "$S/run-instance.sh" "$ID" "${SWB_SEAT:-openai:gpt-5.6-sol}" ${BUDGET:+"$BUDGET"}
  fi
done
