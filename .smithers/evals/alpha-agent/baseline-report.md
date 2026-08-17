# alpha-agent eval suite — baseline

Suite `alpha-agent` over `.smithers/evals/alpha-agent/cases.jsonl`, judged by `claude-sonnet-5`.
Recorded 2026-08-17 (run label `20260817064046-43c468a2`). Native report: `baseline-report.json`.

This run covers the committed corpus — all 21 cases, including the two newest,
`second-human-task-over-red-panel` and `retry-gap-serial-lanes` — against the
landed judge seat (`yolo: false`, no tools, no settings, no MCP, scratch cwd).

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
| 21 | 20 | 1 | 0 | 87s | 330s |

The one red is an `agreement` assertion, not a checker regression: every case's
deterministic verdicts matched its declared ground truth. See
[Judge disagreements](#judge-disagreements).

## Scores per axis

`checks` are the deterministic verdicts the suite asserts on; `judge agreement` is how often
the cheap rubric judge matched them on that axis (N/A axes excluded).

| axis | PASS | FAIL | N/A | judge agreement |
|---|---|---|---|---|
| `parallelism` | 18 | 2 | 1 | 20/20 (100%) |
| `singleReview` | 16 | 4 | 1 | 20/20 (100%) |
| `immediateLanding` | 17 | 3 | 1 | 19/20 (95%) |
| `polishConvergence` | 16 | 4 | 1 | 20/20 (100%) |
| `humanGating` | 13 | 5 | 3 | 18/18 (100%) |

Whole-trace judge agreement: 19/20 cases. Mean rubric score: 0.72.

## Cases

| case | status | assertions | overall | rubric | judge |
|---|---|---|---|---|---|
| `golden-full-run` | pass | 2/2 | PASS | 0.98 | agreed |
| `serial-lanes` | pass | 2/2 | FAIL | 0.70 | agreed |
| `double-pre-merge-review` | pass | 2/2 | FAIL | 0.72 | agreed |
| `unreviewed-lane-lands` | fail | 1/2 | FAIL | 0.55 | disagreed on `immediateLanding` |
| `batched-landing` | pass | 2/2 | FAIL | 0.62 | agreed |
| `reviewed-lane-never-lands` | pass | 2/2 | FAIL | 0.65 | agreed |
| `polish-ends-on-fix` | pass | 2/2 | FAIL | 0.72 | agreed |
| `polish-fix-never-applied` | pass | 2/2 | FAIL | 0.72 | agreed |
| `landed-lane-never-polished` | pass | 2/2 | FAIL | 0.75 | agreed |
| `human-task-before-panel` | pass | 2/2 | FAIL | 0.70 | agreed |
| `human-task-over-not-ready-panel` | pass | 2/2 | FAIL | 0.72 | agreed |
| `escalation-then-clean-panel` | pass | 2/2 | PASS | 1.00 | agreed |
| `single-verifier-panel` | pass | 2/2 | FAIL | 0.78 | agreed |
| `two-lane-partial-overlap` | pass | 2/2 | PASS | 0.92 | agreed |
| `pre-land-polish-lgtm` | pass | 2/2 | FAIL | 0.75 | agreed |
| `landing-precedes-review` | pass | 2/2 | FAIL | 0.60 | agreed |
| `partial-panel-rerun` | pass | 2/2 | FAIL | 0.80 | agreed |
| `implemented-never-reviewed` | pass | 2/2 | FAIL | 0.40 | agreed |
| `second-human-task-over-red-panel` | pass | 2/2 | FAIL | 0.68 | agreed |
| `retry-gap-serial-lanes` | pass | 2/2 | FAIL | 0.65 | agreed |
| `unparsable-payload` | pass | 2/2 | N/A | — | not run |

## Failures

`unreviewed-lane-lands` failed its second assertion. The deterministic row is
exact — `singleReview` FAIL, every other axis as declared — so the checker did
not regress; the case carries `"agreement": true` and the cheap judge did not
agree on this run.

## Judge disagreements

* `unreviewed-lane-lands` — the judge called `immediateLanding` FAIL where the
  checker says PASS. Lane a3 lands at t=64min having never been reviewed, and
  the judge read that as an immediate-landing violation ("no preceding review
  event at all"). The checker scores the axis only over lanes that cleared a
  review, so a3 supplies no evidence for it and the unreviewed landing is
  charged to `singleReview` alone. Both readings are defensible, which is the
  problem: the case claims `"agreement": true` and is not actually unambiguous
  enough to hold a cheap judge to it.

**Known flake.** An earlier run of this same corpus and commit
(`20260817063728-88bbc80f`) was 21/21 with `unreviewed-lane-lands` agreeing, and
disagreed instead on `pre-land-polish-lgtm` — a case that omits `"agreement"`
and therefore did not fail. The deterministic verdicts were identical in both
runs. The `"agreement": true` claim on `unreviewed-lane-lands` is the flaky
gate; either sharpen the rubric's `immediateLanding` wording so an unreviewed
landing is unambiguously charged to `singleReview`, or drop the claim for that
case as the other near-miss cases already do. That is a ground-truth decision
for the suite owner and is deliberately not made here.

## Reading a regression

- A red `alphaEvalJudgeChecks` assertion means the deterministic scorer or the trace
  vocabulary changed: fix `scoreTrace.ts` or the fixture, not the report.
- A red `agreement` assertion alone means the cheap judge drifted: the rubric in
  `alpha-agent-eval-judge.tsx` needs sharpening, or the case is more ambiguous than
  its `"agreement": true` claim.
- Exit code `5` means every red was an environment fault (no judge agent available,
  for example). Repair the harness; do not edit the suite.
