#!/bin/bash
# The full SWE-bench Verified benchmark: all 500 instances, one flows attempt
# each, streaming, resumable, and detached.
#
#   ./fullbench.sh                 start a new benchmark
#   ./fullbench.sh --resume        continue the one already in fullbench/
#   ./fullbench.sh --foreground    run in this process (the rig's own tests)
#   ./fullbench.sh --stop          ask a running driver to stop after its
#                                  in-flight instances finish
#   ./fullbench.sh --clear-pause   remove a PAUSED marker so --resume can start
#
# Detached launch, exactly. Copy this line:
#
#   cd evals/swebench && nohup ./fullbench.sh --resume >> fullbench/launch.log 2>&1 < /dev/null &
#
# `nohup` detaches it from the terminal, and this script then double-forks
# itself — `( worker & )` runs the worker in a subshell that exits immediately,
# so the worker is reparented to launchd — which is what makes it survive the
# session that launched it, not just the terminal. The launcher prints the
# worker's pid and exits; everything after that is in `fullbench/driver.log`.
#
# What it does, per instance, two at a time:
#
#   wait for 8 GiB free -> pull -> run one attempt -> grade THAT instance now,
#   while its image is still local -> archive journal, patch and report ->
#   delete the testbed and the image
#
# The image is the reason for the shape. 500 official images are about 1.5 TB
# and this machine has 16 GiB to spare, shared with the 5x5 best-of-n matrix, so
# nothing multi-gigabyte may outlive the instance that needed it. The five
# images that matrix pinned are never deleted.
#
# Resume is a ledger, not a checkpoint: `fullbench/manifest.jsonl` records every
# state every instance reaches, fsynced before the next one starts. A restart
# skips every instance whose last state is `graded` and re-runs everything else
# from the top, cleanly. A crash mid-instance therefore costs that instance and
# nothing else.
#
# This spends real API tokens. See README.md, "The full benchmark".
set -u
S="$(cd "$(dirname "$0")" && pwd)"
FB="${FB_DIR:-$S/fullbench}"

JOBS="${SWB_FULLBENCH_JOBS:-2}"
BUDGET_USD="${SWB_FULLBENCH_BUDGET_USD:-600}"
CHECKPOINT_EVERY="${SWB_FULLBENCH_CHECKPOINT_EVERY:-25}"
MIN_FREE_MIB="${SWB_FULLBENCH_MIN_FREE_MIB:-8192}"
RUN_ID="${SWB_FULLBENCH_RUN_ID:-fullbench}"
INDEX="${SWB_FULLBENCH_INDEX:-r90}"
SEAT="${SWB_SEAT:-openai:gpt-5.6-sol}"
INSTANCE_BUDGET="${SWB_FULLBENCH_BUDGET:-1200}"
DATASET="${SWB_DATASET:-$S/swb-verified.json}"
SAMPLE="${SWB_SAMPLE:-$S/sample.json}"
POLL_SECONDS="${SWB_FULLBENCH_POLL_SECONDS:-5}"
POLL_LIMIT="${SWB_FULLBENCH_POLL_LIMIT:-720}"
# How many instances this session may schedule. Empty is "everything left",
# which is the benchmark; a number is how an operator spends one night's worth
# and reads the checkpoint before committing the rest, and is how the dry run
# holds a queue still while it kills the driver.
SESSION_LIMIT="${SWB_FULLBENCH_LIMIT:-}"

RESUME=0
FOREGROUND=0
for ARG in "$@"; do
  case "$ARG" in
    --resume) RESUME=1 ;;
    --foreground) FOREGROUND=1 ;;
    --stop)
      if [ -f "$FB/driver.pid" ] && kill -0 "$(cat "$FB/driver.pid" 2>/dev/null)" 2>/dev/null; then
        kill -TERM "$(cat "$FB/driver.pid")"
        echo "fullbench.sh: asked pid $(cat "$FB/driver.pid") to stop"
        exit 0
      fi
      echo "fullbench.sh: no driver is running"; exit 1 ;;
    --clear-pause) rm -f "$FB/PAUSED"; echo "fullbench.sh: pause cleared"; exit 0 ;;
    --help|-h) sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "fullbench.sh: unknown argument '$ARG'"; exit 2 ;;
  esac
done

MANIFEST="$FB/manifest.jsonl"
PROGRESS="$FB/progress.md"

# ---------------------------------------------------------------------------
# The launcher half. Everything above runs in whatever shell called this; from
# here the work happens in a process that outlives it.
# ---------------------------------------------------------------------------
if [ -z "${SWB_FULLBENCH_EXEC:-}" ]; then
  mkdir -p "$FB"
  if [ -f "$FB/driver.pid" ] && kill -0 "$(cat "$FB/driver.pid" 2>/dev/null)" 2>/dev/null; then
    echo "fullbench.sh: a driver is already running (pid $(cat "$FB/driver.pid")). Use --stop first."
    exit 1
  fi
  if [ -f "$FB/PAUSED" ]; then
    echo "fullbench.sh: the benchmark is PAUSED:"
    sed 's/^/  /' "$FB/PAUSED"
    echo "  Raise SWB_FULLBENCH_BUDGET_USD or free disk, then ./fullbench.sh --clear-pause"
    exit 1
  fi
  if [ -f "$MANIFEST" ] && [ "$RESUME" = "0" ]; then
    echo "fullbench.sh: $MANIFEST already exists. Pass --resume to continue it,"
    echo "  or move fullbench/ aside to start a new benchmark."
    exit 1
  fi
  if [ "$FOREGROUND" = "0" ]; then
    rm -f "$FB/driver.pid"
    ( SWB_FULLBENCH_EXEC=1 nohup "$0" "$@" >> "$FB/driver.log" 2>&1 < /dev/null & )
    WAITED=0
    while [ ! -f "$FB/driver.pid" ] && [ "$WAITED" -lt 30 ]; do sleep 1; WAITED=$((WAITED + 1)); done
    if [ -f "$FB/driver.pid" ]; then
      echo "fullbench.sh: driver detached as pid $(cat "$FB/driver.pid")"
      echo "  log      $FB/driver.log"
      echo "  status   ./fullbench-status.sh"
      echo "  stop     ./fullbench.sh --stop"
      exit 0
    fi
    echo "fullbench.sh: the detached driver did not start. The end of $FB/driver.log:"
    tail -20 "$FB/driver.log" 2>/dev/null | sed 's/^/  /'
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# The driver.
# ---------------------------------------------------------------------------
mkdir -p "$FB" "$FB/workers" "$FB/claims" "$FB/patches" "$FB/journals" "$FB/timings" \
  "$FB/logs" "$FB/reports"
# The pid file is written once and never deleted. Liveness is `kill -0` on what
# it holds — which is what every reader already does — and a file that outlives
# the process it names is what makes the launcher's wait race-free: a driver
# that started and finished before the launcher's first poll would otherwise be
# indistinguishable from one that never started.
echo $$ > "$FB/driver.pid"

now_ms() { node -e 'process.stdout.write(String(Date.now()))'; }
log() { printf '%s [driver] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
append() { node "$S/lib/manifest-append.mjs" "$1" "$2"; }
row() { node "$S/lib/fullbench-row.mjs" "$@"; }

# Locks a crashed predecessor may have left. This driver is a singleton — the
# launcher refused to start beside a live one — so anything still held is stale
# and holding it would stall every worker.
rmdir "$FB/.grade-lock" 2>/dev/null || true
rm -rf "$FB/claims"; mkdir -p "$FB/claims"
rm -f "$FB"/workers/*.done "$FB"/workers/*.pid 2>/dev/null || true

if [ ! -f "$DATASET" ]; then log "no dataset at $DATASET — run ./bootstrap.sh first"; exit 1; fi
if [ ! -f "$SAMPLE" ]; then log "no sample at $SAMPLE — run ./bootstrap.sh first"; exit 1; fi

# The five the best-of-5 matrix pinned, whose images this benchmark must never
# delete. Same rule the matrix uses: the seeded sample's first SWB_SAMPLE_COUNT.
PINNED="$(node -e '
  const sample = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
  process.stdout.write(sample.instances.slice(0, Number(process.argv[2])).join(" "))
' "$SAMPLE" "${SWB_SAMPLE_COUNT:-5}")"
if [ -n "${SWB_FULLBENCH_PINNED:-}" ]; then PINNED="$SWB_FULLBENCH_PINNED"; fi

# ---------------------------------------------------------------------------
# One subject, for the whole benchmark.
#
# The rig's rule is one wave one subject, and 500 instances over several days is
# the longest wave there has ever been, so the pin matters more here, not less.
# But the 5x5 matrix in this same rig shares `.subject.json`, and re-pinning
# under it would silently re-arm a wave that ought to have stopped. So:
#
#   no pin        -> ./preflight.sh, and this benchmark owns the pin
#   live pin      -> adopt it; the subject is already the one on disk
#   stale pin     -> refuse. Re-pinning is an operator decision, never a side
#                    effect of starting a benchmark next to another wave.
#
# After this the pin is never touched again. `flows.sh` re-derives the
# fingerprint on every call and stops an instance whose subject moved, and that
# refusal is recorded per instance rather than papered over.
# ---------------------------------------------------------------------------
if [ -n "${SWB_RUN_CMD:-}" ]; then
  # A stubbed run command runs no harness and spends nothing, so it has no
  # subject to pin; the refusal would only stop the driver's own dry run. Same
  # exemption, for the same reason, that `run-matrix.sh` makes.
  log "SWB_RUN_CMD is set — no harness runs, so no subject is pinned"
  SUBJECT_SOURCE=stubbed
elif [ ! -f "$S/.subject.json" ]; then
  log "no subject pinned — running ./preflight.sh"
  "$S/preflight.sh" || { log "preflight failed; a benchmark cannot start"; exit 1; }
  SUBJECT_SOURCE=preflight
elif node "$S/lib/subject.mjs" --expect "$S/.subject.json" --quiet >/dev/null 2>&1; then
  log "adopted the live pin in .subject.json (not re-running preflight: a sibling wave shares it)"
  SUBJECT_SOURCE=adopted
else
  log "the pinned subject in .subject.json is not what is on disk."
  log "  Re-pin deliberately with ./preflight.sh — doing it here would re-arm a sibling wave."
  exit 1
fi

SUBJECT="stubbed"
if [ "$SUBJECT_SOURCE" != "stubbed" ]; then
  SUBJECT="$(node -e '
    process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).stamp)
  ' "$S/.subject.json")"
fi
HEAD_AT_START="$(cd "$S" && git rev-parse HEAD 2>/dev/null || printf 'unknown')"

append "$MANIFEST" "$(row --kind header --at "$(now_ms)" --runId "$RUN_ID" --index "$INDEX" \
  --subject "$SUBJECT" --subjectSource "$SUBJECT_SOURCE" --head "$HEAD_AT_START" \
  --seat "$SEAT" --jobs "$JOBS" --instanceBudgetSeconds "$INSTANCE_BUDGET" \
  --budgetUsd "$BUDGET_USD" --minFreeMiB "$MIN_FREE_MIB" --checkpointEvery "$CHECKPOINT_EVERY" \
  --pinnedImages "$PINNED" --dataset "$DATASET")"

log "subject $SUBJECT ($SUBJECT_SOURCE), HEAD $HEAD_AT_START"
log "jobs $JOBS, budget \$$BUDGET_USD, disk gate ${MIN_FREE_MIB} MiB, checkpoint every $CHECKPOINT_EVERY"
log "images never deleted: $PINNED"

export FB_DIR="$FB"
export SWB_FULLBENCH_INDEX="$INDEX"
export SWB_FULLBENCH_RUN_ID="$RUN_ID"
export SWB_FULLBENCH_MIN_FREE_MIB="$MIN_FREE_MIB"
export SWB_FULLBENCH_PINNED="$PINNED"
export SWB_FULLBENCH_BUDGET="$INSTANCE_BUDGET"
export SWB_SEAT="$SEAT"

QUEUE="$(node "$S/lib/fullbench-queue.mjs" "$DATASET" "$MANIFEST" --remaining)" || {
  log "could not build the queue"; exit 1; }
COUNTS="$(node "$S/lib/fullbench-queue.mjs" "$DATASET" "$MANIFEST" --count)"
DONE_AT_START="$(printf '%s' "$COUNTS" | awk '{print $1}')"
TOTAL="$(printf '%s' "$COUNTS" | awk '{print $3}')"
LAST_CHECKPOINT=$((DONE_AT_START - DONE_AT_START % CHECKPOINT_EVERY))
log "$DONE_AT_START of $TOTAL already graded; $((TOTAL - DONE_AT_START)) to run"

STOPPING=0
PAUSE_REASON=""
RUNNING=0
PIDS=()
NAMES=()

on_term() {
  STOPPING=1
  log "stop requested — no new instances will be scheduled; in-flight ones finish"
}
trap on_term TERM INT

# Reaps every worker that has finished, without blocking. A finished worker is
# one that wrote its `.done` marker: `kill -0` cannot tell a finished child from
# a zombie one, and a zombie is exactly what an unreaped child is.
reap_finished() {
  REAPED=0
  if [ "${#PIDS[@]}" -eq 0 ]; then return 1; fi
  for i in "${!PIDS[@]}"; do
    if [ -z "${PIDS[$i]}" ]; then continue; fi
    if [ -f "$FB/workers/${NAMES[$i]}.done" ]; then
      wait "${PIDS[$i]}" 2>/dev/null
      CODE="$(cat "$FB/workers/${NAMES[$i]}.done" 2>/dev/null || printf 'unknown')"
      rm -f "$FB/workers/${NAMES[$i]}.done" "$FB/workers/${NAMES[$i]}.pid"
      log "${NAMES[$i]} finished (exit $CODE)"
      PIDS[$i]=""
      RUNNING=$((RUNNING - 1))
      REAPED=1
    fi
  done
  return $((1 - REAPED))
}

# Blocks on the oldest tracked worker. Only reached when polling has gone a full
# hour without a `.done` marker, which means a worker died without running its
# own exit path; `wait` on a zombie returns at once.
reap_oldest() {
  if [ "${#PIDS[@]}" -eq 0 ]; then return 1; fi
  for i in "${!PIDS[@]}"; do
    if [ -n "${PIDS[$i]}" ]; then
      log "${NAMES[$i]} left no completion marker — waiting on it directly"
      wait "${PIDS[$i]}" 2>/dev/null
      rm -f "$FB/workers/${NAMES[$i]}.done" "$FB/workers/${NAMES[$i]}.pid"
      PIDS[$i]=""
      RUNNING=$((RUNNING - 1))
      return 0
    fi
  done
  return 1
}

wait_for_slot() {
  POLLS=0
  while [ "$RUNNING" -ge "$JOBS" ]; do
    if reap_finished; then return 0; fi
    POLLS=$((POLLS + 1))
    if [ "$POLLS" -ge "$POLL_LIMIT" ]; then reap_oldest; return 0; fi
    sleep "$POLL_SECONDS"
  done
  return 0
}

checkpoint() {
  node "$S/fullbench-report.mjs" --checkpoint --manifest "$MANIFEST" --dataset "$DATASET" \
    --sample "$SAMPLE" --out "$FB" || log "the report generator failed"
}

pause_now() {
  PAUSE_REASON="$1"
  STOPPING=1
  printf '%s\n' "$PAUSE_REASON" > "$FB/PAUSED"
  append "$MANIFEST" "$(row --kind note --at "$(now_ms)" --note paused --reason "$PAUSE_REASON")"
  log "PAUSED: $PAUSE_REASON"
}

# ---------------------------------------------------------------------------
# The schedule. One pass over what is left, in seeded draw order, two in flight.
# ---------------------------------------------------------------------------
SCHEDULED=0
for ID in $QUEUE; do
  if [ "$STOPPING" = "1" ]; then break; fi
  if [ -n "$SESSION_LIMIT" ] && [ "$SCHEDULED" -ge "$SESSION_LIMIT" ]; then
    log "session limit of $SESSION_LIMIT instances reached; the rest stay queued"
    break
  fi

  # The budget, checked before every launch rather than at a checkpoint: 25
  # instances of overshoot at a few dollars each is real money.
  SPENT_CENTS="$(node "$S/fullbench-report.mjs" --spend-cents --manifest "$MANIFEST" 2>/dev/null || printf 0)"
  BUDGET_CENTS="$(node -e 'process.stdout.write(String(Math.round(Number(process.argv[1]) * 100)))' "$BUDGET_USD")"
  if [ "$SPENT_CENTS" -ge "$BUDGET_CENTS" ]; then
    pause_now "cumulative API cost \$$(node -e 'process.stdout.write((Number(process.argv[1])/100).toFixed(2))' "$SPENT_CENTS") reached the \$$BUDGET_USD budget"
    break
  fi

  # The subject was pinned once and is never re-pinned, but a moving HEAD under
  # it is worth a line in the ledger: it is how a later reader learns that the
  # tree changed during the benchmark even though the bytes the CLI loads did
  # not (or that `flows.sh` is about to start refusing instances).
  HEAD_NOW="$(cd "$S" && git rev-parse HEAD 2>/dev/null || printf 'unknown')"
  if [ "$HEAD_NOW" != "$HEAD_AT_START" ]; then
    append "$MANIFEST" "$(row --kind note --at "$(now_ms)" --note head-moved \
      --from "$HEAD_AT_START" --to "$HEAD_NOW" --beforeInstance "$ID")"
    log "HEAD moved $HEAD_AT_START -> $HEAD_NOW; the subject pin is unchanged and is not re-pinned"
    HEAD_AT_START="$HEAD_NOW"
  fi

  wait_for_slot
  if [ "$STOPPING" = "1" ]; then break; fi

  log "scheduling $ID"
  ( "$S/lib/fullbench-instance.sh" "$ID"; echo $? > "$FB/workers/$ID.done" ) &
  PID=$!
  echo "$PID" > "$FB/workers/$ID.pid"
  PIDS[${#PIDS[@]}]="$PID"
  NAMES[${#NAMES[@]}]="$ID"
  RUNNING=$((RUNNING + 1))
  SCHEDULED=$((SCHEDULED + 1))

  DONE_NOW="$(node "$S/lib/fullbench-queue.mjs" "$DATASET" "$MANIFEST" --count | awk '{print $1}')"
  if [ "$DONE_NOW" -ge "$((LAST_CHECKPOINT + CHECKPOINT_EVERY))" ]; then
    LAST_CHECKPOINT=$((DONE_NOW - DONE_NOW % CHECKPOINT_EVERY))
    log "checkpoint at $DONE_NOW instances"
    checkpoint
  fi
done

log "draining $RUNNING in-flight instances"
while [ "$RUNNING" -gt 0 ]; do
  if ! reap_finished; then sleep "$POLL_SECONDS"; fi
done

log "final checkpoint"
checkpoint
FINAL="$(node "$S/lib/fullbench-queue.mjs" "$DATASET" "$MANIFEST" --count)"
log "$(printf '%s' "$FINAL" | awk '{print $1 " of " $3 " graded, " $2 " left"}')"

if [ -n "$PAUSE_REASON" ]; then exit 7; fi
exit 0
