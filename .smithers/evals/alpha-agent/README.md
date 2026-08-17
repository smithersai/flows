# alpha-agent orchestrator eval suite

Scores an **orchestrator** that runs the flows agent-layer production-readiness
track described in `agent.PROMPT.md`. It does not score a code change, a lane,
or the repository. The subject is the shape of the run itself.

Five axes, taken from the track's phase machine:

| Axis | Doctrine (agent.PROMPT.md) |
|------|----------------------------|
| `parallelism` | Phase 1: implementation lanes run concurrently, one worktree each. |
| `singleReview` | Phase 2: exactly one pre-merge review per lane, no second pass. |
| `immediateLanding` | Phase 3: a lane lands the moment it clears review; never batched. |
| `polishConvergence` | Phase 4: post-land polish loops fix forward to an explicit LGTM. |
| `humanGating` | Phase 7: human tasks are raised only after the panel passes. |

## Running it

```bash
smithers eval .smithers/workflows/alpha-agent-eval-judge.tsx \
  --cases .smithers/evals/alpha-agent/cases.jsonl \
  --suite alpha-agent --concurrency 4 \
  --report .smithers/evals/alpha-agent/baseline-report.json --force
```

The command exits non-zero when a case fails, `5` when every red is an
environment fault. `baseline-report.md` records the last committed baseline.

## What a case is

A case is an **authored trace** of an orchestrator run plus its ground truth.
Nothing in this suite launches the alpha-agent workflow, an implementation
fleet, or any worker that touches the repository: the traces are fixtures
written by hand, so the suite is cheap (one `claude-sonnet-5` call per case),
hermetic, and non-recursive.

The judge seat is configured to keep that guarantee rather than to assume it.
`BaseCliAgent` defaults to `yolo: true` and the run's own cwd, so an
unconfigured seat would hand an authored trace to a permission-bypassing
Claude process sitting in the checkout. Every seat in the fallback chain —
account seats and the ambient-credentials seat alike — is therefore built from
one `JUDGE_SANDBOX` literal: `yolo: false`, `permissionMode: "default"`,
`tools: ""` (no built-in tools), `disableSlashCommands`, `settingSources: ""`
(no user/project/local settings file), `strictMcpConfig` with no `--mcp-config`
(no MCP servers), no `--add-dir` or `--plugin-dir`, and `cwd` set to
`JUDGE_SCRATCH_DIR`, an empty directory under the OS temp dir. The graph test
asserts those restrictions on the *built command line* of every seat, so a new
seat that skips them fails the suite.

A trace is a list of node lifecycle events:

```json
{ "tMin": 70, "node": "a1Review", "phase": "review", "event": "finish", "lane": "a1", "verdict": "APPROVE" }
```

* `tMin` — minutes since the run started, the only clock the suite has.
* `phase` — `impl`, `review`, `land`, `polishReview`, `polishFix`, `panel`,
  `remediate`, `human`, `evals`.
* `lane` — the implementation lane (`a1`…`a7`, `evals`).
* `verdict` — `APPROVE`/`FIX` on reviews, `LGTM`/`FIX` on polish reviews,
  `PRODUCTION-READY`/`NOT-READY` on panel verifiers.
* `kind` — on `human` events, `gated-task` (must sit behind the panel) or
  `escalation` (legitimate after a failed panel).

## Files

| File | Role |
|------|------|
| `cases.source.json` | The readable corpus: each case's trace, description, and expected per-axis verdicts. **Edit this one.** |
| `build-cases.ts` | Emits `cases.jsonl` from `cases.source.json`. Run `bun .smithers/evals/alpha-agent/build-cases.ts` after editing, and commit both. |
| `cases.jsonl` | Generated wire format the CLI reads. Do not hand-edit. |
| `scoreTrace.ts` | The deterministic scorer. Pure: same trace in, same verdicts out. |
| `baseline-report.json` / `baseline-report.md` | The committed baseline. |
| `../../workflows/alpha-agent-eval-judge.tsx` | The judge workflow `smithers eval` runs per case. |
| `../../tests/alpha-agent-eval-judge.test.tsx` | Graph-shape test plus scorer unit tests over this corpus. |

## How a case is graded

Each case runs the judge workflow once:

1. **`deterministicChecks`** (compute, no model) scores the trace with
   `scoreTrace.ts`. This is the ground truth the suite asserts on.
2. **`rubricJudge`** (one `claude-sonnet-5` call) reads only the trace and the
   rubric — never the deterministic result, so it cannot anchor on it — and
   returns its own per-axis verdicts plus a 0..1 score.
3. **`reconcile`** (compute) keeps the deterministic axis verdicts and records
   `rubricScore`, `agreement`, and `disagreements`.

The deterministic checks decide the verdict; the rubric judge is *measured*
against them. Each case therefore asserts two things:

* `alphaEvalJudgeChecks` and `alphaEvalJudgeVerdict` carry the expected axis
  verdicts — a regression here means the checker or the trace vocabulary broke.
* `agreement: true` on the clear-cut cases — a regression here means the cheap
  judge drifted. Borderline cases (`two-lane-partial-overlap`) omit it.

An axis is `N/A` when the trace carries no evidence for it; `N/A` never counts
as a disagreement.

### The deterministic checks

* **parallelism** — the largest number of `impl` intervals alive at one instant
  must be at least `min(laneCount, 3)`. Adjacent lanes (one ends as the next
  starts) do not count as overlapping.
* **singleReview** — per lane, exactly one `review` finish before its landing.
  Zero reviews before a landing, a second pre-merge pass, and a `review` after
  landing are all violations.
* **immediateLanding** — every reviewed lane must land, at or after the moment
  it cleared review and within 30 minutes of it (`thresholds.maxLandGapMin`
  overrides). A larger gap is batching by definition; a landing that *precedes*
  its review is an unreviewed landing, not a fast one.
* **polishConvergence** — every landed lane needs a polish loop whose last
  verdict is `LGTM`, and every `FIX` must be followed by a `polishFix` before
  the next polish review. The window opens at the lane's landing: a
  `polishReview` or `polishFix` logged earlier is pre-merge work and counts for
  nothing, so a pre-land `LGTM` cannot stand in for a polish loop.
* **humanGating** — panel finishes are grouped into **rounds**, because a failed
  panel is remediated and re-run. A round boundary is derived where a verifier
  reports a second time, or where a `remediate` finish sits between two panel
  reports. The first `gated-task` human event is graded against the round that
  was in effect when it was raised: that round needs at least two independent
  verifiers reporting *before* the task, all with `PRODUCTION-READY`, and no
  report from that round may land after the task. A verdict carried over from an
  earlier, superseded round is stale and does not count. Escalations are exempt.

`stats.panelVerdicts` is round-qualified (`r2:codex=PRODUCTION-READY`) so a
stale carry-over is visible in the recorded facts.

## The corpus

| Case | Expected failure |
|------|------------------|
| `golden-full-run` | none — every axis passes |
| `serial-lanes` | `parallelism` |
| `double-pre-merge-review` | `singleReview` (second pass) |
| `unreviewed-lane-lands` | `singleReview` (no review at all) |
| `batched-landing` | `immediateLanding` (held for the batch) |
| `reviewed-lane-never-lands` | `immediateLanding` (abandoned lane) |
| `polish-ends-on-fix` | `polishConvergence` (never reached LGTM) |
| `polish-fix-never-applied` | `polishConvergence` (FIX skipped) |
| `landed-lane-never-polished` | `polishConvergence` (no loop) |
| `human-task-before-panel` | `humanGating` (raised too early) |
| `human-task-over-not-ready-panel` | `humanGating` (panel said NOT-READY) |
| `single-verifier-panel` | `humanGating` (one verifier) |
| `partial-panel-rerun` | `humanGating` (fresh verdict plus a stale one from the failed round) |
| `pre-land-polish-lgtm` | `polishConvergence` (the LGTM predates the landing) |
| `landing-precedes-review` | `immediateLanding` + `singleReview` (landed before its review) |
| `escalation-then-clean-panel` | none — escalation then a passing second panel |
| `two-lane-partial-overlap` | none — two overlapping lanes, gating undecided |
| `unparsable-payload` | none — degrades to `N/A`, no model call |

Every axis has at least one failing case and the corpus holds three clean runs,
so a checker that always answers `PASS` (or always `FAIL`) fails the suite. The
test asserts that coverage property directly.

`partial-panel-rerun`, `pre-land-polish-lgtm`, and `landing-precedes-review` are
the near-miss cases: each is one field away from a clean run and each scored
`PASS` on the checker before the round, post-land, and ordering rules landed.
They omit `agreement` — the distinction they turn on is ordering, not shape, so
the cheap judge is not held to it.

## Adding a case

1. Append to `cases.source.json` with a description, the trace, and the
   expected verdict for all five axes plus `overall`. Add `"agreement": true`
   only when the case is unambiguous enough to hold a cheap judge to it.
2. `bun .smithers/evals/alpha-agent/build-cases.ts`
3. `cd .smithers && bun test ./tests/alpha-agent-eval-judge.test.tsx` — the
   scorer must already agree with the declared ground truth.
4. Re-run the suite and refresh the baseline.

## Input compatibility

The workspace's shared run store has one user input column, `carriedFindings`
(TEXT). The judge workflow's input schema is exactly
`z.object({ carriedFindings: z.string().default("") })`, so every case passes
its payload — `{"caseId": …, "trace": {…}}` — as a JSON string in that column
and the workflow parses it. Any other input column breaks the engine at start.
The workflow's output tables are all prefixed `alphaEvalJudge` for the same
reason: the store is shared with the alpha-agent run.

A payload that does not parse is not a crash: the run still finishes, every
axis scores `N/A`, and the rubric judge never mounts (no model call). The
`unparsable-payload` case pins that behaviour.
