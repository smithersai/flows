#!/bin/bash
# Proves the full-benchmark driver without spending a token.
#
#   ./fullbench-dryrun.sh
#
# `fixtures/check-fullbench.mjs` replays the ledger, the queue and the report
# offline. What it cannot replay is the part that only exists when processes are
# real: pulling and deleting an image, holding the extraction lock, two workers
# in flight, and — the one that matters most — being killed halfway through an
# instance and resuming without re-running what was already graded.
#
# So this runs the real driver, with the real manifest, the real disk gate and
# real docker, over four instances that are in no dataset. The agent is stubbed
# (`SWB_RUN_CMD`) and so is the evaluator (`SWB_GRADE_CMD`); everything between
# them is the code the benchmark runs.
#
# Four phases:
#
#   A  three instances, two in flight, and a `kill -9` while the third is
#      mid-run — the crash a laptop or a closed session produces
#   B  --resume: the two that were graded are skipped, the third re-runs clean
#   D  the disk gate, made to fail: the instance logs its wait and stops rather
#      than pulling into a full disk
#   C  the budget: cumulative cost over the cap PAUSEs the driver instead of
#      quietly spending the rest
#
# Real docker, three tiny images. Which stub instance gets which is decided by
# the seeded draw, the same order the benchmark itself runs in, so the phases
# cannot silently depend on an order the driver does not actually use:
#
#   1st drawn  busybox      pulled, extracted through the rig's extraction lock,
#                           then deleted
#   2nd drawn  hello-world  pulled, empty patch, deleted
#   3rd drawn  alpine       already local, pinned, and still here at the end —
#                           the stand-in for the five images the 5x5 matrix
#                           needs kept warm
#   4th drawn  busybox      never pulled: the disk gate stops it first
#
# Spends no model tokens. Needs docker and about 10 MB of pulls.
set -eu
S="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/flows-fullbench-dryrun-XXXXXX")"
FB="$TMP/fullbench"
LEDGER="$TMP/ledger.txt"
ALL_IDS="stubfull__one stubfull__two stubfull__three stubfull__four"

cleanup() {
  pkill -9 -f "fullbench-instance.sh stubfull__" >/dev/null 2>&1 || true
  pkill -9 -f "dryrun-run.sh stubfull__" >/dev/null 2>&1 || true
  if [ -f "$FB/driver.pid" ]; then kill -9 "$(cat "$FB/driver.pid")" >/dev/null 2>&1 || true; fi
  rmdir "$S/.extract-lock" >/dev/null 2>&1 || true
  for ID in $ALL_IDS; do
    rm -rf "$S/work/${ID}-r90" "$S/journals/${ID}-r90"
    rm -f "$S/patches/${ID}-r90.patch" "$S/patches/${ID}-r90.patch.untracked" \
      "$S/timings/${ID}-r90.json" "$S/logs-agent/${ID}-r90".*
  done
  docker rmi -f busybox:latest hello-world:latest >/dev/null 2>&1 || true
  # SWB_DRYRUN_KEEP=1 leaves the temp directory — the manifest, the report, the
  # progress log and every driver log — for reading after a failure.
  if [ "${SWB_DRYRUN_KEEP:-0}" = "1" ]; then
    echo "dryrun: artifacts kept in $TMP"
  else
    rm -rf "$TMP"
  fi
}
trap cleanup EXIT

# alpine is the disk probe's image and this dry run's stand-in for a pinned
# benchmark image. Without it the "kept" assertion would be vacuous.
if ! docker image inspect alpine:latest >/dev/null 2>&1; then
  docker pull alpine:latest >/dev/null 2>&1 || { echo "dryrun: could not pull alpine"; exit 1; }
fi
docker rmi -f busybox:latest hello-world:latest >/dev/null 2>&1 || true

mkdir -p "$FB" "$TMP/eval-logs"
node -e '
  const fs = require("fs")
  const ids = process.argv[1].split(" ")
  fs.writeFileSync(process.argv[2], JSON.stringify(ids.map((id) => ({
    instance_id: id,
    repo: `stub/${id.replace("stubfull__", "")}`,
    base_commit: "aaa",
    version: "1.0",
    problem_statement: "stub"
  })), null, 2))
' "$ALL_IDS" "$TMP/dataset.json"

# Roles follow the seeded draw, which is the order the driver will schedule in.
ORDER="$(node "$S/lib/fullbench-queue.mjs" "$TMP/dataset.json" "$TMP/absent.jsonl" --all)"
FIRST="$(printf '%s\n' "$ORDER" | sed -n 1p)"
SECOND="$(printf '%s\n' "$ORDER" | sed -n 2p)"
THIRD="$(printf '%s\n' "$ORDER" | sed -n 3p)"
FOURTH="$(printf '%s\n' "$ORDER" | sed -n 4p)"
echo "dryrun: draw order $FIRST $SECOND $THIRD $FOURTH"
printf '%s\n%s\n%s\n%s\n' "$FIRST" "$SECOND" "$THIRD" "$FOURTH" > "$TMP/roles.txt"

# The sample's first entry is what the driver treats as pinned, so the third
# instance's image is the one it must never delete.
printf '{"seed":0,"size":1,"instances":["%s"]}\n' "$THIRD" > "$TMP/sample.json"

node -e '
  const fs = require("fs")
  const [, first, second, third, fourth, out] = process.argv
  fs.writeFileSync(out, JSON.stringify({
    [first]: "busybox:latest",
    [second]: "hello-world:latest",
    [third]: "alpine:latest",
    [fourth]: "busybox:latest"
  }, null, 2))
' "$FIRST" "$SECOND" "$THIRD" "$FOURTH" "$TMP/images.json"

# A journal the cost reader can price: two model calls, in the event shapes
# `lib/run-cost.mjs` reads. $0.67 an instance at the committed price table.
cat > "$TMP/write-journal.mjs" <<'EOF'
import { DatabaseSync } from "node:sqlite"
const database = new DatabaseSync(process.argv[2])
database.exec(
  "create table flows_journal_events (seq integer primary key, emitted_at_ms integer,"
    + " event_type text, payload_json text)"
)
const insert = database.prepare(
  "insert into flows_journal_events (seq, emitted_at_ms, event_type, payload_json) values (?, ?, ?, ?)"
)
const usage = { inputTokens: 100000, cachedInputTokens: 50000, outputTokens: 2000, reasoningTokens: 1000 }
insert.run(1, 1000, "control.agent.turn-opened", JSON.stringify({ seat: "openai:gpt-5.6-sol" }))
insert.run(2, 2000, "control.agent.model-settled", JSON.stringify({ usage }))
insert.run(3, 3000, "control.agent.model-settled", JSON.stringify({ usage }))
database.close()
EOF

cat > "$TMP/dryrun-run.sh" <<EOF
#!/bin/bash
# The stub harness: everything run-instance.sh leaves behind, and none of the
# model calls. The first drawn instance really extracts, so the rig's extraction
# lock is exercised by a real multi-file docker cp.
set -u
ID="\$1"
INDEX="\$4"
eval "\$("$S/lib/run-paths.sh" flows "\$ID" "\$INDEX")"
printf 'S %s\n' "\$ID" >> "$LEDGER"
mkdir -p "\$WORK" "\$JOURNAL" "\$(dirname "\$PATCH")" "\$(dirname "\$TIMINGS")" "\$(dirname "\$LOG_PREFIX")"
# A rendezvous between the first two instances, so "two in flight" is proved by
# construction rather than by two stubs happening to overlap. A serial driver
# would leave the first one waiting here until it timed out, and the timeout is
# a line in the ledger that the assertions fail on.
if [ "\$ID" = "$FIRST" ] || [ "\$ID" = "$SECOND" ]; then
  mkdir -p "$TMP/rendezvous"
  : > "$TMP/rendezvous/\$ID"
  WAITED=0
  until [ -f "$TMP/rendezvous/$FIRST" ] && [ -f "$TMP/rendezvous/$SECOND" ]; do
    sleep 1
    WAITED=\$((WAITED + 1))
    if [ "\$WAITED" -ge 60 ]; then printf 'T %s\n' "\$ID" >> "$LEDGER"; break; fi
  done
fi
if [ "\$ID" = "$FIRST" ]; then
  LOCK="$S/.extract-lock"
  until mkdir "\$LOCK" 2>/dev/null; do sleep 1; done
  TMPC="\$(docker create busybox:latest)"
  docker cp "\$TMPC:/bin/." "\$WORK/" >/dev/null 2>&1
  docker rm -f "\$TMPC" >/dev/null 2>&1
  rmdir "\$LOCK" 2>/dev/null || true
  printf 'X %s %s\n' "\$ID" "\$(ls "\$WORK" | wc -l | tr -d ' ')" >> "$LEDGER"
fi
if [ "\$ID" = "$SECOND" ]; then
  : > "\$PATCH"
else
  printf 'diff --git a/x.py b/x.py\n--- a/x.py\n+++ b/x.py\n@@\n-old\n+new\n' > "\$PATCH"
fi
: > "\$PATCH.untracked"
node "$TMP/write-journal.mjs" "\$JOURNAL/engine.db"
printf '{"instance_id":"%s","wallClockSeconds":1}\n' "\$ID" > "\$TIMINGS"
printf 'stub run\n' > "\$LOG_PREFIX.run.log"
SLEEP=0
if [ -f "$TMP/sleep-\$ID" ]; then SLEEP="\$(cat "$TMP/sleep-\$ID")"; fi
sleep "\$SLEEP"
printf 'E %s\n' "\$ID" >> "$LEDGER"
exit 0
EOF
chmod +x "$TMP/dryrun-run.sh"

cat > "$TMP/dryrun-grade.sh" <<EOF
#!/bin/bash
# The stub evaluator: writes the report file where the real one writes it, so
# the driver's verdict reading is the real code path.
set -u
RUN_ID="\$1"
ID="\$2"
DIR="$TMP/eval-logs/\$RUN_ID/flows-cell-harness/\$ID"
mkdir -p "\$DIR"
RESOLVED=false
if [ "\$ID" = "$FIRST" ]; then RESOLVED=true; fi
printf '{"%s": {"patch_exists": true, "patch_successfully_applied": true, "resolved": %s}}\n' \
  "\$ID" "\$RESOLVED" > "\$DIR/report.json"
printf 'G %s\n' "\$ID" >> "$LEDGER"
EOF
chmod +x "$TMP/dryrun-grade.sh"

export FB_DIR="$FB"
export SWB_DATASET="$TMP/dataset.json"
export SWB_SAMPLE="$TMP/sample.json"
export SWB_SAMPLE_COUNT=1
export SWB_IMAGE_MAP="$TMP/images.json"
export SWB_RUN_CMD="$TMP/dryrun-run.sh"
export SWB_GRADE_CMD="$TMP/dryrun-grade.sh"
export SWB_EVAL_LOG_ROOT="$TMP/eval-logs"
export SWB_FULLBENCH_JOBS=2
export SWB_FULLBENCH_CHECKPOINT_EVERY=2
export SWB_FULLBENCH_POLL_SECONDS=1
export SWB_FULLBENCH_DISK_INTERVAL=1

wait_for() {
  WAITED=0
  until node -e '
    import("'"$S"'/lib/fullbench-manifest.mjs").then(({ read }) => {
      const states = read(process.argv[1]).states
      process.exit(eval(process.argv[2]) ? 0 : 1)
    })
  ' "$FB/manifest.jsonl" "$1" 2>/dev/null; do
    WAITED=$((WAITED + 1))
    if [ "$WAITED" -ge 180 ]; then
      echo "dryrun: timed out waiting for: $1"
      cat "$FB/driver.log" 2>/dev/null || true
      exit 1
    fi
    sleep 1
  done
}

drain_driver() {
  WAITED=0
  while [ -f "$FB/driver.pid" ] && kill -0 "$(cat "$FB/driver.pid" 2>/dev/null)" 2>/dev/null; do
    sleep 1
    WAITED=$((WAITED + 1))
    if [ "$WAITED" -ge 90 ]; then echo "dryrun: driver did not exit"; exit 1; fi
  done
}

wait_for_ledger() {
  WAITED=0
  until grep -qx "$1" "$LEDGER" 2>/dev/null; do
    WAITED=$((WAITED + 1))
    if [ "$WAITED" -ge 180 ]; then
      echo "dryrun: timed out waiting for ledger line: $1"
      cat "$FB/driver.log" 2>/dev/null || true
      exit 1
    fi
    sleep 1
  done
}

echo "== phase A: three instances, two in flight, killed mid-instance"
printf '90\n' > "$TMP/sleep-$THIRD"
SWB_FULLBENCH_LIMIT=3 "$S/fullbench.sh"
wait_for "states.get('$FIRST')?.state === 'cleaned' && states.get('$SECOND')?.state === 'cleaned'"
# The kill has to land while the third instance is *running*, not merely
# scheduled: its manifest row appears when its image is ready, which is before
# the harness starts. Waiting on the harness's own first line is what makes
# "killed mid-instance" mean what it says.
wait_for_ledger "S $THIRD"

# The crash: the driver and every worker, with no chance to clean up.
kill -9 "$(cat "$FB/driver.pid")" 2>/dev/null || true
for PIDFILE in "$FB"/workers/*.pid; do
  if [ -f "$PIDFILE" ]; then kill -9 "$(cat "$PIDFILE")" 2>/dev/null || true; fi
done
pkill -9 -f "fullbench-instance.sh stubfull__" >/dev/null 2>&1 || true
pkill -9 -f "dryrun-run.sh stubfull__" >/dev/null 2>&1 || true
sleep 2
cp "$FB/manifest.jsonl" "$TMP/manifest-after-kill.jsonl"
cp "$LEDGER" "$TMP/ledger-after-kill.txt"
node "$S/lib/fullbench-queue.mjs" "$TMP/dataset.json" "$FB/manifest.jsonl" --remaining \
  > "$TMP/remaining-after-kill.txt"

echo "== phase B: resume — the graded are skipped, the interrupted one re-runs"
printf '0\n' > "$TMP/sleep-$THIRD"
SWB_FULLBENCH_LIMIT=1 "$S/fullbench.sh" --resume
wait_for "states.get('$THIRD')?.state === 'cleaned'"
drain_driver

echo "== phase D: the disk gate, made to fail"
SWB_FULLBENCH_LIMIT=1 SWB_DISK_FREE_MIB=1000 SWB_FULLBENCH_MIN_FREE_MIB=8192 \
  SWB_FULLBENCH_DISK_WAIT_MAX=1 "$S/fullbench.sh" --resume
wait_for "states.get('$FOURTH')?.state === 'failed'"
drain_driver

echo "== phase C: the budget, exceeded"
set +e
SWB_FULLBENCH_LIMIT=1 SWB_FULLBENCH_BUDGET_USD=0.50 "$S/fullbench.sh" --foreground --resume \
  > "$TMP/phase-c.log" 2>&1
echo $? > "$TMP/phase-c.exit"
set -e

echo "== the status screen"
"$S/fullbench-status.sh" > "$TMP/status.txt" 2>&1 || true

echo "== assertions"
{
  docker image inspect busybox:latest >/dev/null 2>&1 && echo "busybox present" || echo "busybox absent"
  docker image inspect hello-world:latest >/dev/null 2>&1 && echo "hello-world present" || echo "hello-world absent"
  docker image inspect alpine:latest >/dev/null 2>&1 && echo "alpine present" || echo "alpine absent"
} > "$TMP/images-final.txt"

node "$S/fixtures/check-dryrun.mjs" "$TMP"
