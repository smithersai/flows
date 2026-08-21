#!/bin/bash
# Runs the flows built-in harness on one SWE-bench Verified instance.
#
#   run-instance.sh <instance_id> [model-seat] [timeout-seconds] [run-index]
#
# Produces work/<instance_id>/ (the agent workspace), patches/<instance_id>.patch
# (the model patch, empty if the agent changed nothing), timings/<instance_id>.json
# (wall clock, for the scorecard), logs-agent/<instance_id>.run.log, and
# journals/<instance_id>-r1/ (the run's journal, copied out of the workspace).
#
# With a run index — `run-instance.sh <id> <seat> <budget> r3` — every one of
# those names carries `-r3`, so five runs of one instance coexist. `lib/run-
# paths.sh` owns the rule and both harnesses derive their names from it. A run
# given an index is a matrix run and deletes its extracted testbed once the patch
# is captured; a run without one keeps the workspace, which is what
# `regen-patch.sh` and the scorecard's default `--work work` read. See README,
# "Best-of-n".
#
# This spends real API tokens and needs docker. See README.md.
#
# `./preflight.sh` must have pinned the subject first: every flows.sh call in
# here re-checks the pin, and the stamp is copied into the timings record so a
# scorecard can never attribute an instance to a subject it did not run.
set -euo pipefail
S="$(cd "$(dirname "$0")" && pwd)"
INSTANCE="${1:-}"
SEAT="${2:-openai:gpt-5.6-sol}"
BUDGET="${3:-1200}"
INDEX="${4:-}"
DATASET="${SWB_DATASET:-$S/swb-verified.json}"

if [ ! -f "$DATASET" ]; then
  echo "[$INSTANCE] no dataset at $DATASET — run ./bootstrap.sh first"; exit 1
fi
BASE="$(node "$S/lib/validate-instance.mjs" "$DATASET" "$INSTANCE")" || exit $?
case "$BUDGET" in
  ''|*[!0-9]*) echo "[$INSTANCE] timeout must be a positive integer"; exit 2 ;;
  0) echo "[$INSTANCE] timeout must be a positive integer"; exit 2 ;;
esac

# The subject the wave measures, pinned by ./preflight.sh. It is stamped into
# this instance's timings record so the scorecard can state which bytes each
# instance ran, and refuse to average two subjects into one wave.
if [ ! -f "$S/.subject.json" ]; then
  echo "[$INSTANCE] no subject pinned — run ./preflight.sh first"; exit 1
fi
SUBJECT="$(node -e '
  process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).stamp);
' "$S/.subject.json")"

IMAGE_ID="$(echo "$INSTANCE" | sed 's/__/_1776_/')"
IMAGE="swebench/sweb.eval.x86_64.${IMAGE_ID}:latest"

# Every artifact name this run writes, from the one place that knows the rule.
# `run-paths.sh` re-validates the instance id and the index before either
# reaches a path or a container name.
RUN_PATHS="$("$S/lib/run-paths.sh" flows "$INSTANCE" ${INDEX:+"$INDEX"})" || exit $?
eval "$RUN_PATHS"
mkdir -p "$WORK_ROOT" "$PATCH_ROOT" "$LOG_ROOT" "$TIMINGS_ROOT"
WORK_ROOT="$(cd "$WORK_ROOT" && pwd -P)"
WORK="$(node -e 'process.stdout.write(require("node:path").resolve(process.argv[1], process.argv[2]))' "$WORK_ROOT" "$(basename "$WORK")")"
if [ "$(dirname "$WORK")" != "$WORK_ROOT" ]; then
  echo "[$RUN_ID] resolved work path escaped $WORK_ROOT"; exit 2
fi

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rmdir "$S/.extract-lock" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "[$RUN_ID] image $IMAGE"
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker pull --platform linux/amd64 "$IMAGE" >"$LOG_PREFIX.pull.log" 2>&1 || {
    echo "[$RUN_ID] PULL FAILED"; exit 1; }
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

# Anchor the patch capture to the tree as extracted, before anything of ours
# touches it. Everything the official image already changed relative to the base
# commit is in this commit, so it cannot reappear as if the agent had written
# it. See lib/snapshot-base.sh.
CAPTURE_BASE="$("$S/lib/snapshot-base.sh" "$WORK")"
echo "[$RUN_ID] capture base $CAPTURE_BASE (base commit $BASE)"

docker rm -f "$CONTAINER" >/dev/null 2>&1
docker run -d --platform linux/amd64 --name "$CONTAINER" \
  -v "$WORK:/testbed" -w /testbed "$IMAGE" sleep infinity >/dev/null 2>&1 || {
  echo "[$RUN_ID] CONTAINER START FAILED"; exit 1; }

# Keep the harness scaffolding out of the model patch.
printf 'flows/\n.flows/\n.jj/\nagent-run.log\n' >> "$WORK/.git/info/exclude"

# The repository's own test runner, from the pinned evaluator's spec map. The
# rig used to prescribe `python -m pytest` for every repo; Django ships no
# pytest module and Sphinx runs under tox, so that command could not verify a
# fix in either, and an agent that cannot run a check cannot know it is done.
TEST_CMD="$("$S/.venv-swb/bin/python" "$S/lib/test-command.py" "$DATASET" "$INSTANCE")" || {
  echo "[$RUN_ID] NO TEST COMMAND — run ./bootstrap.sh first"; exit 1; }

mkdir -p "$WORK/flows/fix"
node "$S/lib/write-flow.mjs" "$DATASET" "$INSTANCE" "$SEAT" "$CONTAINER" "$TEST_CMD" > "$WORK/flows/fix/flow.mdx"

( cd "$WORK" && jj git init --colocate >/dev/null 2>&1 )

# SWB_SKIP_AGENT=1 builds the workspace and captures its patch without running
# the agent or spending a token. The captured patch must then be empty, which is
# the standing proof that capture reports agent edits and nothing else. It
# writes no timings stamp, because no run happened to time.
if [ "${SWB_SKIP_AGENT:-0}" = "1" ]; then
  echo "[$RUN_ID] SWB_SKIP_AGENT=1 — no agent, capture proof only"
  RUN_STATUS=0
else
  echo "[$RUN_ID] agent start ($SEAT, ${BUDGET}s)"
  START=$(date +%s)
  set +e
  (
    cd "$WORK" || exit 1
    A=$("$S/flows.sh" --json plan fix | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.stringify(JSON.parse(s).approval))}catch{process.exit(1)}})') || exit 1
    "$S/flows.sh" --json approve "$A" --scope run >/dev/null 2>&1 || {
      echo "[$RUN_ID] APPROVAL FAILED"; exit 1;
    }
    timeout "$BUDGET" "$S/flows.sh" --json run "$A"
  ) > "$LOG_PREFIX.run.log" 2>&1
  RUN_STATUS=$?
  set -e
  END=$(date +%s)
  echo "[$RUN_ID] agent done in $((END-START))s (status $RUN_STATUS)"

  # The wall clock the scorecard grades speed on. The journal's own span stops at
  # the last journaled event, which is not the same as how long the operator
  # waited for the process, so the process time is recorded here.
  printf '{\n  "instance_id": "%s",\n  "run_id": "%s",\n  "runIndex": "%s",\n  "seat": "%s",\n  "subject": "%s",\n  "budgetSeconds": %s,\n  "startedAt": %s,\n  "endedAt": %s,\n  "wallClockSeconds": %s,\n  "exitStatus": %s,\n  "timedOut": %s\n}\n' \
    "$INSTANCE" "$RUN_ID" "$RUN_INDEX" "$SEAT" "$SUBJECT" "$BUDGET" "$((START*1000))" "$((END*1000))" "$((END-START))" \
    "$RUN_STATUS" "$([ "$RUN_STATUS" -eq 124 ] && printf true || printf false)" \
    > "$TIMINGS"
fi

# The model patch: the working tree against the capture base recorded before the
# agent started, with the harness scaffolding and build noise excluded.
"$S/lib/capture-patch.sh" "$WORK" "$PATCH" \
  ':(exclude)flows' ':(exclude).flows' ':(exclude).jj' ':(exclude)agent-run.log' >/dev/null

echo "[$RUN_ID] patch bytes: $(wc -c < "$PATCH" | tr -d ' ')"
echo "[$RUN_ID] untracked files left out of the patch: $(wc -l < "$PATCH.untracked" | tr -d ' ')"

# The journal, copied out of the workspace it lived in. It is the run's whole
# record — every frame, call, measurement and demand — and until now it only
# ever existed inside a workspace the next wave overwrites. The selector reads
# these and nothing else, so they outlive the tree they were written in.
#
# The write-ahead log and shared-memory files travel with the database. The run
# process has exited by here, so the log is normally already folded in, and
# copying all three costs nothing and cannot lose a tail that is not.
if [ -f "$WORK/.flows/engine.db" ]; then
  mkdir -p "$JOURNAL"
  for FILE in engine.db engine.db-wal engine.db-shm; do
    if [ -f "$WORK/.flows/$FILE" ]; then cp "$WORK/.flows/$FILE" "$JOURNAL/$FILE"; fi
  done
  echo "[$RUN_ID] journal archived to ${JOURNAL#"$S/"}"
fi

# The extracted testbed, once nothing else needs it. A matrix run — one given a
# run index — produces five workspaces per instance and would otherwise keep all
# of them for the whole wave; the patch is captured and the journal is archived
# by this point, so what is left is a checkout the images can reproduce.
#
# A run without an index keeps its workspace: `regen-patch.sh` re-derives a
# patch from it and the scorecard's default `--work work` reads its journal in
# place, and neither may be broken by a change made for the matrix.
# SWB_KEEP_WORKSPACE=1 keeps a matrix run's workspace for debugging;
# SWB_DELETE_WORKSPACE=1 deletes an unindexed run's.
DELETE_WORKSPACE=0
if [ -n "$INDEX" ]; then DELETE_WORKSPACE=1; fi
if [ "${SWB_KEEP_WORKSPACE:-0}" = "1" ]; then DELETE_WORKSPACE=0; fi
if [ "${SWB_DELETE_WORKSPACE:-0}" = "1" ]; then DELETE_WORKSPACE=1; fi
if [ "$DELETE_WORKSPACE" = "1" ]; then
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf -- "$WORK"
  echo "[$RUN_ID] testbed deleted"
fi

exit "$RUN_STATUS"
