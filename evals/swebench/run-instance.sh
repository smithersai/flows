#!/bin/bash
# Runs the flows built-in harness on one SWE-bench Verified instance.
#
#   run-instance.sh <instance_id> [model-seat] [timeout-seconds]
#
# Produces work/<instance_id>/ (the agent workspace), patches/<instance_id>.patch
# (the model patch, empty if the agent changed nothing), timings/<instance_id>.json
# (wall clock, for the scorecard), and logs-agent/<instance_id>.run.log.
#
# This spends real API tokens and needs docker. See README.md.
set -euo pipefail
S="$(cd "$(dirname "$0")" && pwd)"
INSTANCE="${1:-}"
SEAT="${2:-openai:gpt-5.6-sol}"
BUDGET="${3:-1200}"
DATASET="${SWB_DATASET:-$S/swb-verified.json}"

if [ ! -f "$DATASET" ]; then
  echo "[$INSTANCE] no dataset at $DATASET — run ./bootstrap.sh first"; exit 1
fi
BASE="$(node "$S/lib/validate-instance.mjs" "$DATASET" "$INSTANCE")" || exit $?
case "$BUDGET" in
  ''|*[!0-9]*) echo "[$INSTANCE] timeout must be a positive integer"; exit 2 ;;
  0) echo "[$INSTANCE] timeout must be a positive integer"; exit 2 ;;
esac

IMAGE_ID="$(echo "$INSTANCE" | sed 's/__/_1776_/')"
IMAGE="swebench/sweb.eval.x86_64.${IMAGE_ID}:latest"
CONTAINER="flowsbench-$(echo "$INSTANCE" | tr '_.' '--')"

mkdir -p "$S/work" "$S/patches" "$S/logs-agent" "$S/timings"
WORK_ROOT="$(cd "$S/work" && pwd -P)"
WORK="$(node -e 'process.stdout.write(require("node:path").resolve(process.argv[1], process.argv[2]))' "$WORK_ROOT" "$INSTANCE")"
if [ "$(dirname "$WORK")" != "$WORK_ROOT" ]; then
  echo "[$INSTANCE] resolved work path escaped $WORK_ROOT"; exit 2
fi

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rmdir "$S/.extract-lock" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "[$INSTANCE] image $IMAGE"
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker pull --platform linux/amd64 "$IMAGE" >"$S/logs-agent/$INSTANCE.pull.log" 2>&1 || {
    echo "[$INSTANCE] PULL FAILED"; exit 1; }
fi

# Extract the testbed the image ships so the agent edits a real checkout at the
# base commit, then bind it back over /testbed so the same tree is what the
# container's interpreter sees.
#
# Serialize the extraction across concurrent lanes: docker cp of a multi-GB tree
# is the disk-bandwidth spike, and five at once can fill the drive before any
# lane's cleanup runs.
LOCK="$S/.extract-lock"
until mkdir "$LOCK" 2>/dev/null; do sleep 5; done
rm -rf -- "$WORK"; mkdir -p "$WORK"
TMPC="$(docker create --platform linux/amd64 "$IMAGE")"
docker cp "$TMPC:/testbed/." "$WORK/" >/dev/null 2>&1
docker rm -f "$TMPC" >/dev/null 2>&1
rmdir "$LOCK" 2>/dev/null

docker rm -f "$CONTAINER" >/dev/null 2>&1
docker run -d --platform linux/amd64 --name "$CONTAINER" \
  -v "$WORK:/testbed" -w /testbed "$IMAGE" sleep infinity >/dev/null 2>&1 || {
  echo "[$INSTANCE] CONTAINER START FAILED"; exit 1; }

# Keep the harness scaffolding out of the model patch.
printf 'flows/\n.flows/\n.jj/\nagent-run.log\n' >> "$WORK/.git/info/exclude"

# The repository's own test runner, from the pinned evaluator's spec map. The
# rig used to prescribe `python -m pytest` for every repo; Django ships no
# pytest module and Sphinx runs under tox, so that command could not verify a
# fix in either, and an agent that cannot run a check cannot know it is done.
TEST_CMD="$("$S/.venv-swb/bin/python" "$S/lib/test-command.py" "$DATASET" "$INSTANCE")" || {
  echo "[$INSTANCE] NO TEST COMMAND — run ./bootstrap.sh first"; exit 1; }

mkdir -p "$WORK/flows/fix"
node "$S/lib/write-flow.mjs" "$DATASET" "$INSTANCE" "$SEAT" "$CONTAINER" "$TEST_CMD" > "$WORK/flows/fix/flow.mdx"

( cd "$WORK" && jj git init --colocate >/dev/null 2>&1 )

echo "[$INSTANCE] agent start ($SEAT, ${BUDGET}s)"
START=$(date +%s)
set +e
(
  cd "$WORK" || exit 1
  A=$("$S/flows.sh" --json plan fix | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.stringify(JSON.parse(s).approval))}catch{process.exit(1)}})') || exit 1
  "$S/flows.sh" --json approve "$A" --scope run >/dev/null 2>&1 || {
    echo "[$INSTANCE] APPROVAL FAILED"; exit 1;
  }
  timeout "$BUDGET" "$S/flows.sh" --json run "$A"
) > "$S/logs-agent/$INSTANCE.run.log" 2>&1
RUN_STATUS=$?
set -e
END=$(date +%s)
echo "[$INSTANCE] agent done in $((END-START))s (status $RUN_STATUS)"

# The wall clock the scorecard grades speed on. The journal's own span stops at
# the last journaled event, which is not the same as how long the operator
# waited for the process, so the process time is recorded here.
printf '{\n  "instance_id": "%s",\n  "seat": "%s",\n  "budgetSeconds": %s,\n  "startedAt": %s,\n  "endedAt": %s,\n  "wallClockSeconds": %s,\n  "exitStatus": %s,\n  "timedOut": %s\n}\n' \
  "$INSTANCE" "$SEAT" "$BUDGET" "$((START*1000))" "$((END*1000))" "$((END-START))" \
  "$RUN_STATUS" "$([ "$RUN_STATUS" -eq 124 ] && printf true || printf false)" \
  > "$S/timings/$INSTANCE.json"

# The model patch: the working tree against the instance's base commit, with
# the scaffolding and build noise excluded.
# `core.fileMode=false`: extracting the image's testbed to the host does not
# preserve permission bits, so without it the diff is a flood of 100644->100755
# mode changes and no content at all.
( cd "$WORK" && git -c core.fileMode=false --no-pager diff "$BASE" -- \
    ':(exclude)flows' ':(exclude).flows' ':(exclude).jj' \
    ':(exclude)*.pyc' ':(exclude)**/__pycache__/**' ':(exclude).git' \
) > "$S/patches/$INSTANCE.patch" 2>/dev/null
node "$S/lib/strip-modes.mjs" "$S/patches/$INSTANCE.patch" >/dev/null 2>&1

echo "[$INSTANCE] patch bytes: $(wc -c < "$S/patches/$INSTANCE.patch" | tr -d ' ')"
exit "$RUN_STATUS"
