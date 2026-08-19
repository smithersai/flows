#!/bin/bash
# Runs the OpenAI Codex CLI harness on one SWE-bench Verified instance, under
# the same conditions run-instance.sh gives the flows harness: same
# image-derived checkout, same live container for tests, same prompt content,
# same wall-clock budget.
#
#   run-instance-codex.sh <instance_id> [timeout-seconds] [model]
#
# Produces patches-codex/<instance_id>.patch, timings-codex/<instance_id>.json,
# and logs-codex/<instance_id>.*.
#
# This spends real API tokens and needs docker. See README.md.
set -u
S="$(cd "$(dirname "$0")" && pwd)"
INSTANCE="$1"
BUDGET="${2:-1500}"
MODEL="${3:-gpt-5.6-sol}"
DATASET="${SWB_DATASET:-$S/swb-verified.json}"

if [ ! -f "$DATASET" ]; then
  echo "[$INSTANCE] no dataset at $DATASET — run ./bootstrap.sh first"; exit 1
fi

IMAGE_ID="$(echo "$INSTANCE" | sed 's/__/_1776_/')"
IMAGE="swebench/sweb.eval.x86_64.${IMAGE_ID}:latest"
WORK="$S/work-codex/$INSTANCE"
CONTAINER="codexbench-$(echo "$INSTANCE" | tr '_.' '--')"

mkdir -p "$S/work-codex" "$S/patches-codex" "$S/logs-codex" "$S/timings-codex"

echo "[$INSTANCE] image $IMAGE"
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker pull --platform linux/amd64 "$IMAGE" >"$S/logs-codex/$INSTANCE.pull.log" 2>&1 || {
    echo "[$INSTANCE] PULL FAILED"; exit 1; }
fi

# Serialize the testbed extraction across concurrent lanes: docker cp of a
# multi-GB tree is the disk-bandwidth spike, and five at once can fill the
# drive before any lane's cleanup runs.
LOCK="$S/.extract-lock"
until mkdir "$LOCK" 2>/dev/null; do sleep 5; done
trap 'rmdir "$LOCK" 2>/dev/null' EXIT
rm -rf "$WORK"; mkdir -p "$WORK"
TMPC="$(docker create --platform linux/amd64 "$IMAGE")"
docker cp "$TMPC:/testbed/." "$WORK/" >/dev/null 2>&1
docker rm -f "$TMPC" >/dev/null 2>&1
rmdir "$LOCK" 2>/dev/null
trap - EXIT

docker rm -f "$CONTAINER" >/dev/null 2>&1
docker run -d --platform linux/amd64 --name "$CONTAINER" \
  -v "$WORK:/testbed" -w /testbed "$IMAGE" sleep infinity >/dev/null 2>&1 || {
  echo "[$INSTANCE] CONTAINER START FAILED"; exit 1; }

BASE="$(node -e '
const fs=require("fs");
const all=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
process.stdout.write(all.find(r=>r.instance_id===process.argv[2]).base_commit);
' "$DATASET" "$INSTANCE")"

node "$S/lib/write-prompt-codex.mjs" "$DATASET" "$INSTANCE" "$CONTAINER" > "$S/logs-codex/$INSTANCE.prompt.md"

echo "[$INSTANCE] codex start ($MODEL, ${BUDGET}s)"
START=$(date +%s)
# Isolated CODEX_HOME: API-key auth (the same key the flows runs billed), no
# user config — so reasoning effort is pinned here, not inherited from the
# host's config.toml. Medium matches what our harness got as the API default.
export CODEX_HOME="$S/.codex-home"
timeout "$BUDGET" codex exec \
  -C "$WORK" \
  -m "$MODEL" \
  -c model_reasoning_effort="medium" \
  --dangerously-bypass-approvals-and-sandbox \
  --skip-git-repo-check \
  --ephemeral \
  --color never \
  -o "$S/logs-codex/$INSTANCE.last-message.txt" \
  - < "$S/logs-codex/$INSTANCE.prompt.md" \
  > "$S/logs-codex/$INSTANCE.run.log" 2>&1
CODE=$?
END=$(date +%s)
echo "[$INSTANCE] codex done in $((END-START))s (exit $CODE)"

printf '{\n  "instance_id": "%s",\n  "model": "%s",\n  "budgetSeconds": %s,\n  "exitCode": %s,\n  "startedAt": %s,\n  "endedAt": %s,\n  "wallClockSeconds": %s\n}\n' \
  "$INSTANCE" "$MODEL" "$BUDGET" "$CODE" "$((START*1000))" "$((END*1000))" "$((END-START))" \
  > "$S/timings-codex/$INSTANCE.json"

( cd "$WORK" && git -c core.fileMode=false --no-pager diff "$BASE" -- \
    ':(exclude)*.pyc' ':(exclude)**/__pycache__/**' ':(exclude).git' \
    ':(exclude)AGENTS.md' \
) > "$S/patches-codex/$INSTANCE.patch" 2>/dev/null
node "$S/lib/strip-modes.mjs" "$S/patches-codex/$INSTANCE.patch" >/dev/null 2>&1

docker rm -f "$CONTAINER" >/dev/null 2>&1
rm -rf "$WORK"
echo "[$INSTANCE] patch bytes: $(wc -c < "$S/patches-codex/$INSTANCE.patch" | tr -d ' ')"
