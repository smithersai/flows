#!/bin/bash
# Grades collected model patches with the official SWE-bench harness.
#
#   evaluate.sh <run-id> <instance_id> [<instance_id> ...]
#
# Reads patches/ by default; set HARNESS=codex to grade patches-codex/ instead.
# Writes preds-<run-id>.json and the evaluator's own report,
# <model-name>.<run-id>.json, into this directory. Both are transient and
# gitignored; the scorecard reads the report.
set -u
S="$(cd "$(dirname "$0")" && pwd)"
RUN_ID="$1"; shift
HARNESS="${HARNESS:-flows}"

if [ "$HARNESS" = "codex" ]; then
  PATCHES="$S/patches-codex"; MODEL="codex-cli"
else
  PATCHES="$S/patches"; MODEL="flows-cell-harness"
fi

if [ ! -x "$S/.venv-swb/bin/python" ]; then
  echo "no evaluator venv at $S/.venv-swb — run ./bootstrap.sh first"; exit 1
fi

node "$S/lib/make-preds.mjs" "$PATCHES" "$MODEL" "$@" > "$S/preds-$RUN_ID.json"
cd "$S" || exit 1
.venv-swb/bin/python -m swebench.harness.run_evaluation \
  --dataset_name princeton-nlp/SWE-bench_Verified \
  --predictions_path "preds-$RUN_ID.json" \
  --run_id "$RUN_ID" \
  --instance_ids "$@" \
  --max_workers 1 \
  --cache_level env \
  --timeout 1800
