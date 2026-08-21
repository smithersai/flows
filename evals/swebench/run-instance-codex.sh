#!/bin/bash
# Runs the OpenAI Codex CLI harness on one SWE-bench Verified instance, under
# the same conditions run-instance.sh gives the flows harness: same
# image-derived checkout, same live container for tests, same prompt content,
# same wall-clock budget.
#
#   run-instance-codex.sh <instance_id> [timeout-seconds] [model] [run-index]
#
# Produces patches-codex/<instance_id>.patch, timings-codex/<instance_id>.json,
# and logs-codex/<instance_id>.*.
#
# With a run index — `run-instance-codex.sh <id> 1500 gpt-5.6-sol r3` — every one
# of those names carries `-r3`, from the same `lib/run-paths.sh` the flows script
# derives its names from, so a matrix run of five attempts per instance names its
# artifacts identically on both sides. A codex run already deletes its workspace
# when it finishes, so there is no disk policy to add here.
#
# This spends real API tokens and needs docker. See README.md.
set -u
S="$(cd "$(dirname "$0")" && pwd)"
INSTANCE="$1"
BUDGET="${2:-1500}"
MODEL="${3:-gpt-5.6-sol}"
INDEX="${4:-}"
DATASET="${SWB_DATASET:-$S/swb-verified.json}"

if [ ! -f "$DATASET" ]; then
  echo "[$INSTANCE] no dataset at $DATASET — run ./bootstrap.sh first"; exit 1
fi

IMAGE_ID="$(echo "$INSTANCE" | sed 's/__/_1776_/')"
IMAGE="swebench/sweb.eval.x86_64.${IMAGE_ID}:latest"

# Every artifact name this run writes, from the one place that knows the rule.
# `run-paths.sh` re-validates the instance id and the index before either reaches
# a path, a container name or an image name.
RUN_PATHS="$("$S/lib/run-paths.sh" codex "$INSTANCE" ${INDEX:+"$INDEX"})" || exit $?
eval "$RUN_PATHS"
mkdir -p "$WORK_ROOT" "$PATCH_ROOT" "$LOG_ROOT" "$TIMINGS_ROOT"

# The isolated CODEX_HOME must exist and hold an API-key login before
# `codex exec` runs. The CLI refuses to start when CODEX_HOME names a missing
# directory and does not create it, and a home with no auth record fails every
# request with 401 even when OPENAI_API_KEY is exported — the key reaches the
# API through this login, not through the environment. The directory is
# gitignored, so a fresh checkout always starts without both.
mkdir -p "$S/.codex-home"
if ! CODEX_HOME="$S/.codex-home" codex login status >/dev/null 2>&1; then
  if [ -z "${OPENAI_API_KEY:-}" ]; then
    echo "[$RUN_ID] no OPENAI_API_KEY to log codex in with"; exit 1
  fi
  printenv OPENAI_API_KEY | CODEX_HOME="$S/.codex-home" codex login --with-api-key >/dev/null 2>&1 || {
    echo "[$RUN_ID] codex login failed"; exit 1; }
fi

echo "[$RUN_ID] image $IMAGE"
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker pull --platform linux/amd64 "$IMAGE" >"$LOG_PREFIX.pull.log" 2>&1 || {
    echo "[$RUN_ID] PULL FAILED"; exit 1; }
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

# Same capture base as the flows side: the tree as the image ships it, so the
# image's own pre_install churn cannot enter the patch. Both harnesses are
# captured under one rule or the comparison is not a comparison.
CAPTURE_BASE="$("$S/lib/snapshot-base.sh" "$WORK")"
echo "[$RUN_ID] capture base $CAPTURE_BASE"

docker rm -f "$CONTAINER" >/dev/null 2>&1
docker run -d --platform linux/amd64 --name "$CONTAINER" \
  -v "$WORK:/testbed" -w /testbed "$IMAGE" sleep infinity >/dev/null 2>&1 || {
  echo "[$RUN_ID] CONTAINER START FAILED"; exit 1; }

node "$S/lib/write-prompt-codex.mjs" "$DATASET" "$INSTANCE" "$CONTAINER" > "$LOG_PREFIX.prompt.md"

# Network access is a benchmark condition, not a detail. SWB_CODEX_NETWORK=off
# runs codex under its workspace-write sandbox, which denies network egress;
# anything else keeps the bypass that grants it.
#
# It matters because on 2026-08-19 the pytest-dev__pytest-6197 trace showed
# codex resolving that instance by fetching the upstream fix and the upstream
# testing/test_collection.py at tag 5.2.4 from GitHub — the release that fixed
# the bug, and the file holding the graded tests. Our harness made no network
# call on the same instance. A comparison where one side may read the answer
# and the other does not is not measuring the same thing, so the condition is
# now explicit and recorded in the run's timings.
if [ "${SWB_CODEX_NETWORK:-on}" = "off" ]; then
  CODEX_SANDBOX_ARGS="--sandbox workspace-write"
else
  CODEX_SANDBOX_ARGS="--dangerously-bypass-approvals-and-sandbox"
fi

echo "[$RUN_ID] codex start ($MODEL, ${BUDGET}s)"
START=$(date +%s)
# Isolated CODEX_HOME: API-key auth (the same key the flows runs billed), no
# user config — so reasoning effort is pinned here, not inherited from the
# host's config.toml. Medium matches what our harness got as the API default.
export CODEX_HOME="$S/.codex-home"
timeout "$BUDGET" codex exec \
  -C "$WORK" \
  -m "$MODEL" \
  -c model_reasoning_effort="medium" \
  ${CODEX_SANDBOX_ARGS} \
  --skip-git-repo-check \
  --ephemeral \
  --color never \
  -o "$LOG_PREFIX.last-message.txt" \
  - < "$LOG_PREFIX.prompt.md" \
  > "$LOG_PREFIX.run.log" 2>&1
CODE=$?
END=$(date +%s)
echo "[$RUN_ID] codex done in $((END-START))s (exit $CODE)"

printf '{\n  "instance_id": "%s",\n  "run_id": "%s",\n  "runIndex": "%s",\n  "model": "%s",\n  "budgetSeconds": %s,\n  "network": "%s",\n  "exitCode": %s,\n  "startedAt": %s,\n  "endedAt": %s,\n  "wallClockSeconds": %s\n}\n' \
  "$INSTANCE" "$RUN_ID" "$RUN_INDEX" "$MODEL" "$BUDGET" "${SWB_CODEX_NETWORK:-on}" "$CODE" "$((START*1000))" "$((END*1000))" "$((END-START))" \
  > "$TIMINGS"

"$S/lib/capture-patch.sh" "$WORK" "$PATCH" \
  ':(exclude)AGENTS.md' >/dev/null

docker rm -f "$CONTAINER" >/dev/null 2>&1
rm -rf "$WORK"
echo "[$RUN_ID] patch bytes: $(wc -c < "$PATCH" | tr -d ' ')"
echo "[$RUN_ID] untracked files left out of the patch: $(wc -l < "$PATCH.untracked" | tr -d ' ')"
