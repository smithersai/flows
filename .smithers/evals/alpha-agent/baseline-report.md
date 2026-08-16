# alpha-agent eval suite — baseline

Suite `alpha-agent` over `.smithers/evals/alpha-agent/cases.jsonl`, judged by `claude-sonnet-5`.
Recorded 2026-08-16. Native report: `baseline-report.json`.

```bash
smithers eval .smithers/workflows/alpha-agent-eval-judge.tsx \
  --cases .smithers/evals/alpha-agent/cases.jsonl \
  --suite alpha-agent --concurrency 4 \
  --report .smithers/evals/alpha-agent/baseline-report.json --force
```

## Summary

| cases | passed | failed | inconclusive | wall clock | agent time |
|---|---|---|---|---|---|
| 15 | 15 | 0 | 0 | 140s | 489s |

## Scores per axis

`checks` are the deterministic verdicts the suite asserts on; `judge agreement` is how often
the cheap rubric judge matched them on that axis (N/A axes excluded).

| axis | PASS | FAIL | N/A | judge agreement |
|---|---|---|---|---|
| `parallelism` | 13 | 1 | 1 | 14/14 (100%) |
| `singleReview` | 12 | 2 | 1 | 14/14 (100%) |
| `immediateLanding` | 12 | 2 | 1 | 14/14 (100%) |
| `polishConvergence` | 11 | 3 | 1 | 14/14 (100%) |
| `humanGating` | 10 | 3 | 2 | 13/13 (100%) |

Whole-trace judge agreement: 14/14 cases. Mean rubric score: 0.79.

## Cases

| case | status | assertions | overall | rubric | judge |
|---|---|---|---|---|---|
| `golden-full-run` | pass | 2/2 | PASS | 1.00 | agreed |
| `serial-lanes` | pass | 2/2 | FAIL | 0.65 | agreed |
| `double-pre-merge-review` | pass | 2/2 | FAIL | 0.80 | agreed |
| `unreviewed-lane-lands` | pass | 2/2 | FAIL | 0.65 | agreed |
| `batched-landing` | pass | 2/2 | FAIL | 0.72 | agreed |
| `reviewed-lane-never-lands` | pass | 2/2 | FAIL | 0.75 | agreed |
| `polish-ends-on-fix` | pass | 2/2 | FAIL | 0.75 | agreed |
| `polish-fix-never-applied` | pass | 2/2 | FAIL | 0.72 | agreed |
| `landed-lane-never-polished` | pass | 2/2 | FAIL | 0.80 | agreed |
| `human-task-before-panel` | pass | 2/2 | FAIL | 0.75 | agreed |
| `human-task-over-not-ready-panel` | pass | 2/2 | FAIL | 0.75 | agreed |
| `escalation-then-clean-panel` | pass | 2/2 | PASS | 1.00 | agreed |
| `single-verifier-panel` | pass | 2/2 | FAIL | 0.72 | agreed |
| `two-lane-partial-overlap` | pass | 2/2 | PASS | 0.95 | agreed |
| `unparsable-payload` | pass | 2/2 | N/A | — | not run |

## Failures

None. Every case matched its declared ground truth.

## Reading a regression

- A red `alphaEvalJudgeChecks` assertion means the deterministic scorer or the trace
  vocabulary changed: fix `scoreTrace.ts` or the fixture, not the report.
- A red `agreement` assertion alone means the cheap judge drifted: the rubric in
  `alpha-agent-eval-judge.tsx` needs sharpening, or the case is more ambiguous than
  its `"agreement": true` claim.
- Exit code `5` means every red was an environment fault (no judge agent available,
  for example). Repair the harness; do not edit the suite.
