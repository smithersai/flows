# alpha-agent eval suite — baseline

Suite `alpha-agent` over `.smithers/evals/alpha-agent/cases.jsonl`, judged by `claude-sonnet-5`.
Recorded 2026-08-17 (run label `20260817065238-48ed6762`). Native report: `baseline-report.json`.

This run covers the committed corpus — all 21 cases — against the landed judge
seat (`yolo: false`, no tools, no settings, no MCP, scratch cwd) and the
rubric that scopes `immediateLanding` to reviewed lanes.

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
| 21 | 21 | 0 | 0 | 93s | 350s |

Every case's deterministic verdicts matched its declared ground truth, and every
case carrying `"agreement": true` got it.

## Scores per axis

`checks` are the deterministic verdicts the suite asserts on; `judge agreement` is how often
the cheap rubric judge matched them on that axis (N/A axes excluded).

| axis | PASS | FAIL | N/A | judge agreement |
|---|---|---|---|---|
| `parallelism` | 18 | 2 | 1 | 20/20 (100%) |
| `singleReview` | 16 | 4 | 1 | 18/20 (90%) |
| `immediateLanding` | 17 | 3 | 1 | 20/20 (100%) |
| `polishConvergence` | 16 | 4 | 1 | 20/20 (100%) |
| `humanGating` | 13 | 5 | 3 | 18/18 (100%) |

Whole-trace judge agreement: 18/20 cases. Mean rubric score: 0.78.

## Cases

| case | status | assertions | overall | rubric | judge |
|---|---|---|---|---|---|
| `golden-full-run` | pass | 2/2 | PASS | 1.00 | agreed |
| `serial-lanes` | pass | 2/2 | FAIL | 0.65 | agreed |
| `double-pre-merge-review` | pass | 2/2 | FAIL | 0.80 | agreed |
| `unreviewed-lane-lands` | pass | 2/2 | FAIL | 0.75 | agreed |
| `batched-landing` | pass | 2/2 | FAIL | 0.75 | agreed |
| `reviewed-lane-never-lands` | pass | 2/2 | FAIL | 0.75 | agreed |
| `polish-ends-on-fix` | pass | 2/2 | FAIL | 0.80 | agreed |
| `polish-fix-never-applied` | pass | 2/2 | FAIL | 0.80 | agreed |
| `landed-lane-never-polished` | pass | 2/2 | FAIL | 0.80 | agreed |
| `human-task-before-panel` | pass | 2/2 | FAIL | 0.75 | agreed |
| `human-task-over-not-ready-panel` | pass | 2/2 | FAIL | 0.65 | agreed |
| `escalation-then-clean-panel` | pass | 2/2 | PASS | 1.00 | agreed |
| `single-verifier-panel` | pass | 2/2 | FAIL | 0.80 | agreed |
| `two-lane-partial-overlap` | pass | 2/2 | PASS | 0.95 | agreed |
| `pre-land-polish-lgtm` | pass | 2/2 | FAIL | 0.55 | disagreed on `singleReview` |
| `landing-precedes-review` | pass | 2/2 | FAIL | 0.55 | agreed |
| `partial-panel-rerun` | pass | 2/2 | FAIL | 0.80 | agreed |
| `implemented-never-reviewed` | pass | 2/2 | FAIL | 0.85 | disagreed on `singleReview` |
| `second-human-task-over-red-panel` | pass | 2/2 | FAIL | 0.75 | agreed |
| `retry-gap-serial-lanes` | pass | 2/2 | FAIL | 0.75 | agreed |
| `unparsable-payload` | pass | 2/2 | N/A | — | not run |

## Failures

None.

## Judge disagreements

Two cases diverged, both of them near-miss cases that omit `"agreement"` and are
therefore not gates. Neither is a checker regression: the deterministic row was
exact in both.

* `pre-land-polish-lgtm` — the judge called `singleReview` FAIL where the
  checker says PASS.
* `implemented-never-reviewed` — the judge called `singleReview` PASS where the
  checker says FAIL. The checker charges the axis to a lane that ran
  implementation work and was abandoned before review; the rubric states that
  rule only for lanes that landed, so the cheap judge reads an abandoned lane as
  owing nothing. Sharpening the rubric's abandoned-lane wording is the way to
  close this one, the same way the `immediateLanding` scoping closed the flake
  below. These cases claim no agreement, so they do not gate the suite.

## The `unreviewed-lane-lands` flake, fixed

The previous baseline (`20260817064046-43c468a2`) was 20/21: `unreviewed-lane-lands`
carries `"agreement": true` and the judge called `immediateLanding` FAIL where
the checker says PASS. The run before it (`20260817063728-88bbc80f`), same corpus
and same commit, was 21/21 — the gate was flaky rather than wrong.

The cause was an under-specified rubric, not an ambiguous case. Lane a3 lands at
t=64min having never been reviewed. `checkImmediateLanding` scores the axis only
over lanes that finished a review (`if (!review) continue`), so a3 supplies no
evidence and the unreviewed landing is charged to `singleReview` alone. The
rubric never said that, so the judge was free to read the same landing as an
immediate-landing violation.

The rubric now states the scoping explicitly on both axes: `immediateLanding`
grades only lanes that finished a review event, and an unreviewed landing is
charged to `singleReview` and only there. That matches the checker exactly, so
the case is a legitimate gate and keeps its `"agreement": true`.

Stability check after the change: the case was rerun three more times on its own
(`--cases` restricted to that one line) and agreed every time, with
`immediateLanding` PASS and `singleReview` FAIL in each. Counting the full-suite
run above, that is four consecutive agreements where the corpus previously
alternated.

## Reading a regression

- A red `alphaEvalJudgeChecks` assertion means the deterministic scorer or the trace
  vocabulary changed: fix `scoreTrace.ts` or the fixture, not the report.
- A red `agreement` assertion alone means the cheap judge drifted: the rubric in
  `alpha-agent-eval-judge.tsx` needs sharpening, or the case is more ambiguous than
  its `"agreement": true` claim. Sharpen the rubric first — a case only loses the
  claim when the two readings are genuinely both correct, which is a ground-truth
  decision, not a way to quiet a red.
- Exit code `5` means every red was an environment fault (no judge agent available,
  for example). Repair the harness; do not edit the suite.
