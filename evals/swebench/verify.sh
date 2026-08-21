#!/bin/bash
# Verifies the scorecard generator and instance guidance without model calls.
#
#   ./verify.sh
#
# Builds the fixture journal twice — without and with the harness's exact
# `ModelSettled.durationMillis` field — scores both, and asserts every reported
# number against `fixtures/mirror-results.json` and the committed codex baseline.
# Then replays the rig's instance guidance and its patch capture over throwaway
# git repositories shaped like the official images, checks that the subject
# fingerprint still names the bytes the CLI actually loads, and replays the
# read-only liveness checker over synthesised journals.
#
# It also pins the two harnesses to one prompt: everything one side is taught and
# the other is not is a variable the comparison does not control.
#
# The best-of-n half is checked the same way: the per-run naming rule, the matrix
# scheduler over a stub harness command, the journal-only selector over two real
# waves, and the report generator over recorded evaluator verdicts.
#
# So is the full benchmark's half that does not need processes: the manifest's
# fold, the resume boundary, and the scoreboard. The half that does —
# pull, extract, delete, kill, resume — is `./fullbench-dryrun.sh`, which needs
# docker and is not run here. The codex backfill splits the same way:
# `./codex-backfill-dryrun.sh` is its process half.
#
# The analysis bundle is checked here in full, and the check that matters most is
# what it refuses to print: the gold patch, the graded test file, the
# FAIL_TO_PASS and PASS_TO_PASS identifiers and the maintainer hints are each a
# sentinel in the fixture's dataset row and none may appear in the output. An
# analyst who is handed the answer is not designing a trace a real run could
# follow.
#
# The lock every lane in the rig shares is checked here too — mutual exclusion,
# recovery from a holder killed with -9, and the ownership rule that stops one
# lane freeing another's lock — because a defect there is silent until two
# multi-gigabyte extractions are already running on one disk.
#
# Spends no tokens, needs no docker, needs no dataset. Run it after touching
# scorecard.ts, prices.ts, the journal's event shapes, patch capture,
# lib/subject.mjs, lib/check-liveness.mjs, lib/write-flow.mjs,
# lib/write-prompt-codex.mjs, lib/run-paths.sh, lib/lock.sh,
# lib/journal-facts.mjs, select-candidate.mjs, run-matrix.sh, matrix-report.mjs,
# fullbench.sh, fullbench-report.mjs or anything under lib/fullbench-*. The
# subject check needs a built CLI: run ./preflight.sh first if
# `packages/cli/dist` is absent.
set -eu
S="$(cd "$(dirname "$0")" && pwd)"

score() {
  node "$S/scorecard.ts" \
    --work "$S/fixtures/work" \
    --patches "$S/fixtures/patches" \
    --timings "$S/fixtures/timings" \
    --report "$S/fixtures/flows-cell-harness.mirror.json" \
    --subject "$S/fixtures/subject.json" \
    --out "$S/fixtures" \
    --instances "$(node -e '
      const rows=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
      process.stdout.write(rows.map(r=>r.id).join(","));
    ' "$S/fixtures/mirror-results.json")" >/dev/null
}

echo "== journal without a per-call duration"
node "$S/fixtures/make-fixture.mjs"
score
node "$S/fixtures/check.mjs" expect-no-latency

echo "== journal with a per-call duration"
node "$S/fixtures/make-fixture.mjs" --with-latency
score
node "$S/fixtures/check.mjs" expect-latency

echo "verify.sh: the scorecard generator agrees with the recorded wave."

echo "== repository-specific verification guidance"
python3 "$S/fixtures/test-test-command.py"
node "$S/fixtures/check-rig.mjs"

echo "== patch capture"
node "$S/fixtures/check-capture.mjs"

echo "== the subject under test"
node "$S/fixtures/check-agreement.mjs"
node "$S/fixtures/check-subject.mjs"

echo "== the read-only liveness reading"
node "$S/fixtures/check-liveness-report.mjs"

echo "== one prompt, two harnesses"
node "$S/fixtures/check-prompts.mjs"

echo "== per-run artifact names"
node "$S/fixtures/check-run-paths.mjs"

echo "== the matrix scheduler"
node "$S/fixtures/check-matrix.mjs"

echo "== the journal-only selector"
node "$S/fixtures/check-selector.mjs"

echo "== the matrix report"
node "$S/fixtures/check-matrix-report.mjs"

echo "== the lock every lane shares"
"$S/fixtures/check-lock.sh"

echo "== the full benchmark's ledger, queue and report"
node "$S/fixtures/check-fullbench.mjs"

echo "== the analysis bundle, and what it withholds"
node "$S/fixtures/check-trace-bundle.mjs"
