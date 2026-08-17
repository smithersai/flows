# alpha-agent eval suite — baseline

Suite `alpha-agent` over `.smithers/evals/alpha-agent/cases.jsonl`, judged by `claude-sonnet-5`.
Recorded 2026-08-17 (run label `20260817061421-ba0e9025`). Native report: `baseline-report.json`.

This run covers the committed corpus — all 19 cases, including
`partial-panel-rerun`, `pre-land-polish-lgtm`, `landing-precedes-review`, and
`implemented-never-reviewed` — against the landed judge seat (`yolo: false`, no
tools, no settings, no MCP, scratch cwd).

It ran against an **isolated run store**, not the workspace store: the suite was
launched from a scratch workspace (`.smithers/workflows` and
`.smithers/evals` symlinked in) outside the checkout, so the engine anchored its
`smithers.db` there and the shared store — in use by the live alpha-agent run —
was never written. Reproduce it that way; running from the repo root or from a
lane worktree writes into the workspace store, because a worktree nested under
`.smithers/` anchors on the repository root.

```bash
smithers eval .smithers/workflows/alpha-agent-eval-judge.tsx \
  --cases .smithers/evals/alpha-agent/cases.jsonl \
  --suite alpha-agent --concurrency 4 \
  --report .smithers/evals/alpha-agent/baseline-report.json --force
```

## Summary

| cases | passed | failed | inconclusive | wall clock | agent time |
|---|---|---|---|---|---|
| 19 | 19 | 0 | 0 | 87s | 302s |

## Scores per axis

`checks` are the deterministic verdicts the suite asserts on; `judge agreement` is how often
the cheap rubric judge matched them on that axis (N/A axes excluded).

| axis | PASS | FAIL | N/A | judge agreement |
|---|---|---|---|---|
| `parallelism` | 17 | 1 | 1 | 18/18 (100%) |
| `singleReview` | 14 | 4 | 1 | 16/18 (89%) |
| `immediateLanding` | 15 | 3 | 1 | 18/18 (100%) |
| `polishConvergence` | 14 | 4 | 1 | 18/18 (100%) |
| `humanGating` | 12 | 4 | 3 | 16/16 (100%) |

Whole-trace judge agreement: 16/18 cases. Mean rubric score: 0.73.

## Cases

| case | status | assertions | overall | rubric | judge |
|---|---|---|---|---|---|
| `golden-full-run` | pass | 2/2 | PASS | 1.00 | agreed |
| `serial-lanes` | pass | 2/2 | FAIL | 0.75 | agreed |
| `double-pre-merge-review` | pass | 2/2 | FAIL | 0.72 | agreed |
| `unreviewed-lane-lands` | pass | 2/2 | FAIL | 0.65 | agreed |
| `batched-landing` | pass | 2/2 | FAIL | 0.60 | agreed |
| `reviewed-lane-never-lands` | pass | 2/2 | FAIL | 0.75 | agreed |
| `polish-ends-on-fix` | pass | 2/2 | FAIL | 0.72 | agreed |
| `polish-fix-never-applied` | pass | 2/2 | FAIL | 0.78 | agreed |
| `landed-lane-never-polished` | pass | 2/2 | FAIL | 0.80 | agreed |
| `human-task-before-panel` | pass | 2/2 | FAIL | 0.60 | agreed |
| `human-task-over-not-ready-panel` | pass | 2/2 | FAIL | 0.80 | agreed |
| `escalation-then-clean-panel` | pass | 2/2 | PASS | 1.00 | agreed |
| `single-verifier-panel` | pass | 2/2 | FAIL | 0.72 | agreed |
| `two-lane-partial-overlap` | pass | 2/2 | PASS | 0.95 | agreed |
| `pre-land-polish-lgtm` | pass | 2/2 | FAIL | 0.60 | disagreed on `singleReview` |
| `landing-precedes-review` | pass | 2/2 | FAIL | 0.65 | disagreed on `singleReview` |
| `partial-panel-rerun` | pass | 2/2 | FAIL | 0.78 | agreed |
| `implemented-never-reviewed` | pass | 2/2 | FAIL | 0.35 | agreed |
| `unparsable-payload` | pass | 2/2 | N/A | — | not run |

## Failures

None. Every case matched its declared ground truth.

## Judge disagreements

Both are on `singleReview`, and both are on near-miss cases that deliberately
omit `"agreement": true`, so neither is an assertion failure:

* `pre-land-polish-lgtm` — the judge called `singleReview` FAIL where the checker
  says PASS. The lane holds exactly one pre-merge review; the judge read the
  pre-land `polishReview` as a second pass.
* `landing-precedes-review` — the judge called `singleReview` PASS where the
  checker says FAIL. The lane's only review finished *after* the landing, so no
  review preceded the merge; the judge scored the review's existence, not its
  position.

`implemented-never-reviewed` is the corpus's newest case and the judge matched
the checker on it, including the `singleReview` FAIL for the lane that was
implemented and abandoned before review.

## Reading a regression

- A red `alphaEvalJudgeChecks` assertion means the deterministic scorer or the trace
  vocabulary changed: fix `scoreTrace.ts` or the fixture, not the report.
- A red `agreement` assertion alone means the cheap judge drifted: the rubric in
  `alpha-agent-eval-judge.tsx` needs sharpening, or the case is more ambiguous than
  its `"agreement": true` claim.
- Exit code `5` means every red was an environment fault (no judge agent available,
  for example). Repair the harness; do not edit the suite.
