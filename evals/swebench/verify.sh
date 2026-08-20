#!/bin/bash
# Verifies the scorecard generator end to end against a past wave's numbers.
#
#   ./verify.sh
#
# Builds the fixture journal twice — without and with the harness's exact
# `ModelSettled.durationMillis` field — scores both, and asserts every reported
# number against `fixtures/mirror-results.json` and the committed codex baseline.
#
# Spends no tokens, needs no docker, needs no dataset. Run it after touching
# scorecard.ts, prices.ts, or the journal's event shapes.
set -eu
S="$(cd "$(dirname "$0")" && pwd)"

score() {
  node "$S/scorecard.ts" \
    --work "$S/fixtures/work" \
    --patches "$S/fixtures/patches" \
    --timings "$S/fixtures/timings" \
    --reports "$S/fixtures" \
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
