#!/bin/bash
# Grades collected model patches with the official SWE-bench harness.
#
#   evaluate.sh <run-id> <instance_id> [<instance_id> ...]
#
# Reads patches/ by default; set HARNESS=codex to grade patches-codex/ instead.
# Writes preds-<run-id>.json and the evaluator's own report,
# <model-name>.<run-id>.json, into this directory. Both are transient and
# gitignored; the scorecard reads the report.
#
# SWB_EVAL_WORKERS sets the evaluator's concurrency. It defaults to 1, and
# raising it is not merely a speed/disk tradeoff: with this evaluator (swebench
# 4.0.4) and `--cache_level env`, concurrent workers race in the post-run image
# cleanup and the run dies with `docker.errors.ImageNotFound` on an image
# another worker already removed. Every instance still grades — the 2026-08-19
# attempt logged "2 ran successfully, 0 failed" — but the crash happens before
# the report is written, so the whole grading is lost. Measured on the same two
# instances: workers=3 crashed with no report, workers=1 wrote the report.
#
# The wave itself (run-sample.sh) is a different matter and does run its
# instances concurrently; only grading serializes.
#
# SWB_CACHE_LEVEL is the evaluator's `--cache_level`. It defaults to `env`,
# which deletes each official instance image once that instance is graded — a
# 3 GB re-pull for the next wave. Set it to `instance` for a supplementary
# grading that should leave the image cache as it found it. It changes what is
# kept on disk, never how a patch is graded.
set -u
S="$(cd "$(dirname "$0")" && pwd)"
RUN_ID="$1"; shift
HARNESS="${HARNESS:-flows}"
WORKERS="${SWB_EVAL_WORKERS:-1}"
CACHE_LEVEL="${SWB_CACHE_LEVEL:-env}"

case "$WORKERS" in
  ''|*[!0-9]*|0) echo "SWB_EVAL_WORKERS must be a positive integer"; exit 2 ;;
esac
case "$CACHE_LEVEL" in
  none|base|env|instance) ;;
  *) echo "SWB_CACHE_LEVEL must be none, base, env or instance"; exit 2 ;;
esac

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
# lib/grade.py is the evaluator, run with the rig's architecture. See its
# docstring: the evaluator picks arm64 from platform.machine() alone, while
# every instance here was produced against a --platform linux/amd64 checkout.
.venv-swb/bin/python "$S/lib/grade.py" \
  --dataset_name princeton-nlp/SWE-bench_Verified \
  --predictions_path "preds-$RUN_ID.json" \
  --run_id "$RUN_ID" \
  --instance_ids "$@" \
  --max_workers "$WORKERS" \
  --cache_level "$CACHE_LEVEL" \
  --timeout 1800
