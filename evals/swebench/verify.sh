#!/bin/bash
# Verifies the scorecard generator and instance guidance without model calls.
#
#   ./verify.sh
#
# Builds the fixture journal twice — without and with the harness's exact
# `ModelSettled.durationMillis` field — scores both, and asserts every reported
# number against `fixtures/mirror-results.json` and the committed codex baseline.
# Then replays the rig's instance guidance and its patch capture over throwaway
# git repositories shaped like the official images.
#
# Spends no tokens, needs no docker, needs no dataset. Run it after touching
# scorecard.ts, prices.ts, the journal's event shapes, or patch capture.
set -eu
S="$(cd "$(dirname "$0")" && pwd)"

score() {
  node "$S/scorecard.ts" \
    --work "$S/fixtures/work" \
    --patches "$S/fixtures/patches" \
    --timings "$S/fixtures/timings" \
    --report "$S/fixtures/flows-cell-harness.mirror.json" \
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
