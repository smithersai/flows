#!/bin/bash
# One instance of the full benchmark, from image to verdict to empty disk.
#
#   lib/fullbench-instance.sh <instance_id>
#
# This is the streaming unit `fullbench.sh` schedules two of at a time. It runs
# the whole life of one instance in one process so that nothing multi-gigabyte
# outlives the instance that needed it:
#
#   disk gate -> pull -> disk gate -> run -> archive -> grade -> delete
#
# **Grading happens here, per instance, while the image is still local.** The
# alternative — run all 500, then grade all 500 — needs every image twice and a
# second pass that re-pulls 1.5 TB. Grading one instance the moment its patch
# exists costs one image, once.
#
# Every state it reaches is appended to the manifest before the next one starts,
# so a kill at any point leaves a ledger that says exactly how far this instance
# got. `graded` is the resume boundary: anything short of it re-runs from the
# top on the next start, and this script purges its own instance's artifacts on
# entry so that re-run is clean.
#
# Environment, all set by `fullbench.sh`:
#
#   FB_DIR                        the fullbench directory
#   SWB_FULLBENCH_INDEX           the run index every artifact carries (r90)
#   SWB_FULLBENCH_RUN_ID          the evaluator run id all 500 accumulate into
#   SWB_FULLBENCH_MIN_FREE_MIB    the disk gate, in MiB (8192)
#   SWB_FULLBENCH_DISK_WAIT_MAX   how long the gate may block before giving up
#   SWB_FULLBENCH_DISK_INTERVAL   how often the gate re-checks
#   SWB_FULLBENCH_PINNED          ids whose images are never deleted
#   SWB_SEAT, SWB_FULLBENCH_BUDGET, SWB_MODEL_NAME
#
# Two stubs exist for the rig's own dry run, and they are the same convention
# `run-matrix.sh` already uses for `SWB_RUN_CMD`:
#
#   SWB_RUN_CMD     replaces the harness run: <cmd> <id> <budget> "" <index>
#   SWB_GRADE_CMD   replaces the evaluator:   <cmd> <run-id> <id>
#   SWB_IMAGE_MAP   a JSON file of id -> image ref, so a dry run can pull a
#                   4 MB image through the real pull/delete path
#
# Exit status: 0 when the instance reached a verdict, non-zero when it did not.
# A harness run that timed out or crashed still reaches a verdict — that is the
# benchmark measuring something — so it is a success here.
set -u
S="$(cd "$(dirname "$0")/.." && pwd)"
ID="${1:-}"
FB="${FB_DIR:-$S/fullbench}"
INDEX="${SWB_FULLBENCH_INDEX:-r90}"
RUN_ID="${SWB_FULLBENCH_RUN_ID:-fullbench}"
MIN_FREE_MIB="${SWB_FULLBENCH_MIN_FREE_MIB:-8192}"
DISK_WAIT_MAX="${SWB_FULLBENCH_DISK_WAIT_MAX:-3600}"
DISK_INTERVAL="${SWB_FULLBENCH_DISK_INTERVAL:-60}"
PINNED="${SWB_FULLBENCH_PINNED:-}"
SEAT="${SWB_SEAT:-openai:gpt-5.6-sol}"
BUDGET="${SWB_FULLBENCH_BUDGET:-1200}"
MODEL="${SWB_MODEL_NAME:-flows-cell-harness}"
DATASET="${SWB_DATASET:-$S/swb-verified.json}"
EVAL_LOG_ROOT="${SWB_EVAL_LOG_ROOT:-$S/logs/run_evaluation}"

if [ -z "$ID" ]; then echo "usage: lib/fullbench-instance.sh <instance_id>" >&2; exit 2; fi

MANIFEST="$FB/manifest.jsonl"
WAITS="$FB/waits.jsonl"

now_ms() { node -e 'process.stdout.write(String(Date.now()))'; }
log() { printf '%s [%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$ID" "$*"; }
append() { node "$S/lib/manifest-append.mjs" "$1" "$2"; }

# A JSON row, built by node so that a value this script splices in can never
# produce a manifest line that does not parse.
row() { node "$S/lib/fullbench-row.mjs" "$@"; }

# ---------------------------------------------------------------------------
# The claim. One instance, one live run — the rule `run-matrix.sh` enforces by
# scheduling, enforced here by the filesystem as well, because two drivers is a
# thing an operator can do by accident and two runs of one instance share an
# image, an image cache and a testbed.
# ---------------------------------------------------------------------------
CLAIM="$FB/claims/$ID"
mkdir -p "$FB/claims"
if ! mkdir "$CLAIM" 2>/dev/null; then
  log "already claimed by another worker — refusing to run it twice"
  exit 3
fi

IMAGE_ID="$(printf '%s' "$ID" | sed 's/__/_1776_/')"
IMAGE="swebench/sweb.eval.x86_64.${IMAGE_ID}:latest"
if [ -n "${SWB_IMAGE_MAP:-}" ] && [ -f "$SWB_IMAGE_MAP" ]; then
  MAPPED="$(node -e '
    const map = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
    process.stdout.write(map[process.argv[2]] ?? "")
  ' "$SWB_IMAGE_MAP" "$ID")"
  if [ -n "$MAPPED" ]; then IMAGE="$MAPPED"; fi
fi

KEEP_IMAGE=0
for PIN in $PINNED; do
  if [ "$PIN" = "$ID" ]; then KEEP_IMAGE=1; fi
done

cleanup() { rmdir "$CLAIM" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

fail() {
  append "$MANIFEST" "$(row --kind instance --id "$ID" --state failed --at "$(now_ms)" \
    --image "$IMAGE" --reason "$1")"
  log "FAILED: $1"
  exit 1
}

# ---------------------------------------------------------------------------
# The disk gate. Before every pull, and again before the extraction, because
# both are multi-gigabyte and the 5x5 matrix in the same rig is spending the
# same disk. Every wait is a row in waits.jsonl and a line in the driver log:
# a benchmark that silently sat still for two hours is indistinguishable from a
# hung one, and the difference is the whole reason this is logged.
# ---------------------------------------------------------------------------
disk_gate() {
  PHASE="$1"
  WAITED=0
  while :; do
    FREE="$("$S/lib/disk-free.sh")"
    case "$FREE" in
      ''|*[!0-9]*) FREE=0 ;;
    esac
    if [ "$FREE" -ge "$MIN_FREE_MIB" ]; then
      if [ "$WAITED" -gt 0 ]; then log "disk gate cleared after ${WAITED}s (${FREE} MiB free)"; fi
      return 0
    fi
    append "$WAITS" "$(row --kind wait --id "$ID" --phase "$PHASE" --at "$(now_ms)" \
      --freeMiB "$FREE" --neededMiB "$MIN_FREE_MIB" --waitedSeconds "$WAITED")"
    log "disk gate ($PHASE): ${FREE} MiB free, need ${MIN_FREE_MIB} MiB — waiting ${DISK_INTERVAL}s (waited ${WAITED}s)"
    if [ "$WAITED" -ge "$DISK_WAIT_MAX" ]; then
      log "disk gate ($PHASE): gave up after ${WAITED}s"
      return 1
    fi
    sleep "$DISK_INTERVAL"
    WAITED=$((WAITED + DISK_INTERVAL))
  done
}

# ---------------------------------------------------------------------------
# Purge. Whatever a previous attempt at this instance left behind, in the shared
# roots and under fullbench/, goes before this attempt starts. A resumed
# instance re-runs clean rather than inheriting half a workspace, and the
# manifest's `pulled` row is what says an attempt began.
# ---------------------------------------------------------------------------
RUN_PATHS="$("$S/lib/run-paths.sh" flows "$ID" "$INDEX")" || fail "run-paths refused ${ID}/${INDEX}"
eval "$RUN_PATHS"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
rm -rf -- "$WORK" "$JOURNAL"
rm -f -- "$PATCH" "$PATCH.untracked" "$TIMINGS" "$LOG_PREFIX".*
rm -rf -- "$FB/journals/$ID"
rm -f -- "$FB/patches/$ID.patch" "$FB/patches/$ID.patch.untracked" \
  "$FB/timings/$ID.json" "$FB/logs/$ID.run.log" "$FB/logs/$ID.pull.log" "$FB/reports/$ID.json"
mkdir -p "$FB/patches" "$FB/journals" "$FB/timings" "$FB/logs" "$FB/reports"

# ---------------------------------------------------------------------------
# Pull. Skipped when the image is already here — which it is for the five the
# 5x5 matrix pinned, and for nothing else, because this script deletes every
# other one on its way out.
# ---------------------------------------------------------------------------
STARTED_AT="$(now_ms)"
if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  log "image $IMAGE already local"
  PULLED=cached
else
  disk_gate pull || fail "disk gate timed out before the pull"
  log "pulling $IMAGE"
  if ! docker pull --platform linux/amd64 "$IMAGE" > "$FB/logs/$ID.pull.log" 2>&1; then
    fail "docker pull failed; see fullbench/logs/$ID.pull.log"
  fi
  PULLED=pulled
fi
append "$MANIFEST" "$(row --kind instance --id "$ID" --state pulled --at "$(now_ms)" \
  --image "$IMAGE" --pull "$PULLED" --startedAt "$STARTED_AT" --index "$INDEX")"

# ---------------------------------------------------------------------------
# Run. One attempt, no retries: the whole point of the full benchmark is what
# one flows attempt scores on all 500, and the best-of-5 matrix is the other
# measurement. The extraction inside `run-instance.sh` takes the rig's existing
# `.extract-lock`, so however many workers are in flight only one multi-gigabyte
# `docker cp` runs at a time.
# ---------------------------------------------------------------------------
disk_gate extract || fail "disk gate timed out before the run"
RUN_STARTED="$(now_ms)"
if [ -n "${SWB_RUN_CMD:-}" ]; then
  "$SWB_RUN_CMD" "$ID" "$BUDGET" "" "$INDEX"
else
  "$S/run-instance.sh" "$ID" "$SEAT" "$BUDGET" "$INDEX"
fi
RUN_STATUS=$?
RUN_ENDED="$(now_ms)"
log "harness exit $RUN_STATUS in $(( (RUN_ENDED - RUN_STARTED) / 1000 ))s"

# The patch is captured after the agent, so its existence is what says the
# workspace was built and the attempt really happened. An exit status is not:
# a timeout exits 124 with a perfectly good patch, and a pull failure exits 1
# with nothing at all.
if [ ! -f "$PATCH" ]; then
  fail "the run captured no patch (exit $RUN_STATUS)"
fi
PATCH_BYTES="$(wc -c < "$PATCH" | tr -d ' ')"

# Archive first, delete second. Everything downstream — the report, any later
# forensics, the next drive — reads these and never the workspace.
cp "$PATCH" "$FB/patches/$ID.patch"
if [ -f "$PATCH.untracked" ]; then cp "$PATCH.untracked" "$FB/patches/$ID.patch.untracked"; fi
if [ -f "$TIMINGS" ]; then cp "$TIMINGS" "$FB/timings/$ID.json"; fi
if [ -f "$LOG_PREFIX.run.log" ]; then cp "$LOG_PREFIX.run.log" "$FB/logs/$ID.run.log"; fi
if [ -d "$JOURNAL" ]; then
  mkdir -p "$FB/journals/$ID"
  cp "$JOURNAL"/* "$FB/journals/$ID/" 2>/dev/null || true
fi
# The shared roots stay as the matrix left them: this instance's artifacts live
# under fullbench/ now, and 500 stray `-r90` files in `patches/` would bury the
# matrix's own.
rm -rf -- "$JOURNAL"
rm -f -- "$PATCH" "$PATCH.untracked" "$TIMINGS" "$LOG_PREFIX".*

COST="$(node "$S/lib/run-cost.mjs" "$FB/journals/$ID" 2>/dev/null || printf '{}')"
append "$MANIFEST" "$(row --kind instance --id "$ID" --state ran --at "$RUN_ENDED" \
  --image "$IMAGE" --exit "$RUN_STATUS" --patchBytes "$PATCH_BYTES" \
  --runStartedAt "$RUN_STARTED" --runEndedAt "$RUN_ENDED" \
  --wallSeconds "$(( (RUN_ENDED - RUN_STARTED) / 1000 ))" --cost-json "$COST")"

# ---------------------------------------------------------------------------
# Grade, immediately, into the one accumulating run id. Serialized across
# workers by a lock: `evaluate.sh` documents that concurrent evaluator workers
# race in the post-run image cleanup and lose the whole report, and two workers
# each running their own single-instance grading is the same race.
# ---------------------------------------------------------------------------
VERDICT=""
if [ "$PATCH_BYTES" = "0" ]; then
  # Not a grading. The official evaluator drops an empty prediction before it
  # starts a container, so there is no verdict to read; "the agent changed
  # nothing" is a fact about the patch and is recorded as one.
  VERDICT="empty patch"
  log "patch is empty — recorded as 'empty patch' without invoking the evaluator"
else
  GRADE_LOCK="$FB/.grade-lock"
  until mkdir "$GRADE_LOCK" 2>/dev/null; do sleep 5; done
  if [ "$KEEP_IMAGE" = "1" ]; then CACHE_LEVEL=instance; else CACHE_LEVEL=env; fi
  log "grading as $RUN_ID (cache_level $CACHE_LEVEL)"
  if [ -n "${SWB_GRADE_CMD:-}" ]; then
    "$SWB_GRADE_CMD" "$RUN_ID" "$ID" >> "$FB/logs/$ID.grade.log" 2>&1
  else
    # `evaluate.sh` resolves SWB_PATCHES against the rig directory, so the
    # archive it grades has to be inside it. Stripping the rig prefix off FB is
    # how that is checked: a prefix that did not strip is a directory the
    # evaluator would look for in the wrong place.
    REL_PATCHES="${FB#"$S/"}/patches"
    if [ "$REL_PATCHES" = "$FB/patches" ]; then
      rmdir "$GRADE_LOCK" 2>/dev/null || true
      fail "FB_DIR ($FB) is outside the rig, and the evaluator resolves its patches inside it"
    fi
    SWB_PATCHES="$REL_PATCHES" SWB_MODEL_NAME="$MODEL" SWB_CACHE_LEVEL="$CACHE_LEVEL" \
      "$S/evaluate.sh" "$RUN_ID" "$ID" >> "$FB/logs/$ID.grade.log" 2>&1
  fi
  GRADE_STATUS=$?
  rmdir "$GRADE_LOCK" 2>/dev/null || true

  REPORT="$EVAL_LOG_ROOT/$RUN_ID/$MODEL/$ID/report.json"
  if [ -f "$REPORT" ]; then
    cp "$REPORT" "$FB/reports/$ID.json"
    VERDICT="$(node -e '
      const report = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
      const row = report[process.argv[2]]
      if (row === undefined) { process.stdout.write("eval error"); }
      else { process.stdout.write(row.resolved === true ? "resolved" : "unresolved"); }
    ' "$REPORT" "$ID")"
  else
    VERDICT="eval error"
    log "the evaluator wrote no report for this instance (exit $GRADE_STATUS)"
  fi
fi

append "$MANIFEST" "$(row --kind instance --id "$ID" --state graded --at "$(now_ms)" \
  --image "$IMAGE" --verdict "$VERDICT")"
log "verdict: $VERDICT"

# ---------------------------------------------------------------------------
# Delete. The testbed is already gone — `run-instance.sh` deletes an indexed
# run's workspace once the patch is captured — so what is left is the image.
# The five the 5x5 matrix pinned are never deleted, whatever this instance is,
# because that wave needs them warm and re-pulling one costs 3 GB.
# ---------------------------------------------------------------------------
if [ "$KEEP_IMAGE" = "1" ]; then
  log "image kept: $ID is one of the pinned five"
  REMOVED=kept
else
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  if docker image inspect "$IMAGE" >/dev/null 2>&1; then
    docker rmi -f "$IMAGE" >/dev/null 2>&1 || log "could not delete $IMAGE"
  fi
  if docker image inspect "$IMAGE" >/dev/null 2>&1; then REMOVED=present; else REMOVED=deleted; fi
fi
rm -rf -- "$WORK"

append "$MANIFEST" "$(row --kind instance --id "$ID" --state cleaned --at "$(now_ms)" \
  --image "$IMAGE" --image-state "$REMOVED" --freeMiB "$("$S/lib/disk-free.sh")")"
log "cleaned (image $REMOVED)"
exit 0
