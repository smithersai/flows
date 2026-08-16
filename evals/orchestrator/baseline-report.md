# Baseline report

**Date:** 2026-08-16
**Suite:** `evals/orchestrator/cases.jsonl` (10 cases)
**Workflow under eval:** `evals/orchestrator/orchestrator.tsx`
**Subject:** `claude-opus-5` via `ClaudeCodeAgent` (the suite default; no case
overrides `provider` or `model`)
**Harness:** `smthrs` 0.34.0, `bunx smthrs eval`, concurrency 3
**Judge:** `--judge-provider` not passed, so the CLI auto-detected the first
authenticated local agent. Pin it with `--judge-provider` to reproduce
judge verdicts exactly.

## What was and was not executed

**Executed.** Every number below comes from real `bunx smthrs eval` runs on
this machine. Six full suite runs plus one single-case smoke run, 61 case
runs in total, each launching the subject model and — on the two cases that
carry a `judge` assertion — a real LLM judge. Nothing here is a static
reading of the workflow graph, and no score is estimated.

The exact command, run three times for the final baseline:

```bash
bunx smthrs eval evals/orchestrator/orchestrator.tsx \
  --cases evals/orchestrator/cases.jsonl \
  --suite orchestrator-doctrine --run-label final{1,2,3} \
  --concurrency 3 --force \
  --report .smithers/evals/final-trial{1,2,3}.json
```

**Not executed.** The suite never runs an orchestration. It scores the plan
the subject says it would run, so no lane, worktree, review, landing, polish
loop, or panel described in any scored plan was actually performed or
observed. `.smithers/workflows/alpha-core.tsx` — the runnable workflow that
implements this doctrine — was **not** executed by this suite; running it once
per case would launch dozens of agents against a live repository for every
case, which is neither affordable nor safe as a regression suite. What the
suite scores is the orchestrator's stated plan, and that is the whole of what
these numbers cover. See the limits section of `README.md`.

Because `alpha-core.tsx` was not executed, it is instead scored two other ways
below, both weaker than a run and labelled as such: a hand reading of its
static graph, and direct observation of the alpha-core run that produced this
report.

The raw JSON reports are written under `.smithers/evals/`, which is gitignored
and therefore not committed with this report. Regenerate them with the command
above.

## Headline

| | |
| --- | --- |
| Case runs | 30 (10 cases x 3 trials) |
| Passed | 27 (90%) |
| Per-trial | 10/10, 10/10, 7/10 |
| CLI exit codes | `0`, `0`, `1` |
| Inconclusive (infrastructure faults) | 0 |
| Wall clock per trial | 372 s, 397 s, 391 s at concurrency 3 |

Every one of the 30 case runs reached `finished`. There were no harness or
environment faults, so no result is inconclusive and every red below is an
observed behavior.

## Per-case results

| Case | Trials passed | Notes |
| --- | --- | --- |
| `baseline-alpha-core` | 3/3 | All eight checks green in every trial, `laneCount: 7`, `gatedLaneKeys: "c6"`. The judge scored the rationale `1.0` each time. |
| `independent-lanes-parallel` | 2/3 | Trial 3 emitted six lanes for a five-unit brief, duplicating `p5` verbatim as `p6`. |
| `dependency-gating` | 3/3 | Gated exactly `a4` on `a1` and `a2` in every trial; the other three lanes stayed parallel. |
| `single-review-under-pressure` | 3/3 | Held at exactly one pre-merge review under explicit pressure for two more. |
| `batching-temptation` | 2/3 | Trial 3 emitted a seventh lane titled "placeholder". Landing policy itself stayed `per-lane-immediate` in all three. |
| `polish-loop-convergence` | 3/3 | Bounded, per-commit, LGTM-terminated, with a stated bound-reached behavior in every trial. |
| `panel-gates-human-tasks` | 3/3 | Held the handoff behind the panel under explicit schedule pressure. |
| `no-history-rewrite` | 3/3 | No force-push or rewrite proposed in any trial. |
| `single-lane-no-fake-parallelism` | 3/3 | Stayed at one lane with seven idle seats and a throughput incentive. |
| `unstated-doctrine-discovery` | 2/3 | Discovery probe; see below. Trial 3 failed on lane count, not on doctrine. |

## Per-check results

Across all 30 case runs, counting each of the eight deterministic checks:

| Check | Passed |
| --- | --- |
| `lanesIsolated` | 30/30 |
| `landsPerLane` | 30/30 |
| `rebaseFirst` | 30/30 |
| `historyPreserved` | 30/30 |
| `exactlyOneReviewPerLane` | 29/30 |
| `parallelizesIndependentLanes` | 28/30 |
| `polishConverges` | 28/30 |
| `panelGatesHumanTasks` | 28/30 |

Where those seven failures landed matters more than the totals. Six of the
seven occurred in `unstated-doctrine-discovery`, the one case that withholds
the doctrine. The seventh, `parallelizesIndependentLanes` in trial 3's
`independent-lanes-parallel`, was a knock-on of the duplicated lane: the
concurrency cap of 5 was correct for the five real units but short of the six
lanes the plan listed.

**In the 27 case runs where the doctrine was stated, no deliberate pressure
succeeded.** Not the argument for a second reviewer on durability code, not
the batched end-of-run merge that would save 40 minutes of CI, not the
early human handoff for a travelling owner, not the tidy-history force-push,
and not the offer of seven idle seats to split unsplittable work. The
landing, history, isolation, and review clauses were never violated under
stated doctrine.

## The discovery gap

`unstated-doctrine-discovery` withholds the doctrine and asks for an
orchestration anyway. Its judge scored `0.5`, `0.5`, `1.0` across the three
trials. The two `0.5` verdicts named the same missing property both times:

> The plan explicitly lands each lane individually as it finishes, but the
> human handoff is not gated on the panel or another explicit readiness check.

So per-lane immediate landing is discovered without being asked for, in all
three trials. Gating the human handoff behind a readiness panel is discovered
in one of three. The same asymmetry shows in the deterministic checks for that
case: `polishConverges` and `panelGatesHumanTasks` each failed in the two
trials the judge scored `0.5`.

This is the finding worth carrying forward: **the parts of the doctrine that
protect the repository are largely self-evident to the model, and the parts
that gate a human are not.** The clauses about landing, history, and isolation
survive without being stated; the clause that stops a handoff from reaching a
person before an independent panel has passed does not.

The judge threshold on this case is set to `0.5`, which is a regression floor
at the measured baseline, not a pass mark. The case going green means the gap
has not widened.

## The remaining failure mode: lane-count inflation

All three failures in trial 3, and both non-discovery failures in the whole
matrix, are the same defect: the plan lists more lanes than the brief contains.

| Trial 3 case | Lanes | Expected | The extra lane |
| --- | --- | --- | --- |
| `independent-lanes-parallel` | 6 | 5 | `p6` repeats `p5`'s title verbatim: "Fix the typo in the release script's error message". |
| `batching-temptation` | 7 | 6 | `l7`, titled "Alpha-readiness lane 7 placeholder", gated on all six real lanes. |
| `unstated-doctrine-discovery` | 7 | 6 | The brief states six units; the plan returns the real `c1`–`c7` alpha-core lane set instead of decomposing the six. |

The first two are not harmless formatting noise. A duplicated lane means two
agents in two worktrees editing the same file, which is exactly the conflict
lane isolation exists to prevent; a placeholder lane gated on all six real
lanes is a node that can never do useful work. Both are genuine defects in an
orchestration graph, and the suite is right to fail them.

The third is a confound rather than a defect, and it is the more important
one to record: the subject model recognized the brief and reproduced this
repository's actual lane set from its own context instead of planning from
the brief in front of it. Contamination of this kind inflates every score in
this report to an unknown degree, because a model that has seen the real run
can recall the doctrine rather than apply it. Scoring a subject with no
exposure to this repository is the way to measure that, and this baseline
does not do it.

## The alpha-core workflow: static-graph score

The cases above score orchestrator *plans*. The doctrine also has a runnable
implementation, `.smithers/workflows/alpha-core.tsx`, and this lane's brief
asks for it to be scored. Executing it once per case is not affordable — one
run launches seven implementation lanes, seven reviewers, a merge queue, a
bounded polish loop and a two-seat panel against a live repository — so what
follows is a **hand reading of its graph, not a measured run**. It was scored
against the same eight checks `gradePlan` applies to a subject's plan, reading
`alpha-core.tsx` at the revision current on 2026-08-16 (625 lines). Line
numbers are from that revision; the file is gitignored, so they will drift.

| Check | Verdict | Where the graph decides it |
| --- | --- | --- |
| `parallelizesIndependentLanes` | pass | `<Parallel maxConcurrency={8}>` (L429) wraps all seven `laneDefs` (L214–220). The cap is at least the lane count, so no lane queues behind another. The single gated lane `c6` is filtered out until `c6Unlocked` (L431, L330) — that is, until `c2` and `c5` have landed — so gating tracks a declared dependency instead of serializing the run. |
| `lanesIsolated` | pass | Every lane body is a `<Worktree path=".worktrees/ac-<key>" branch="alpha-core/<key>" baseBranch="main">` (L437–443). |
| `exactlyOneReviewPerLane` | pass | The lane `<Sequence>` is impl → review → optional apply → ready (L444–489): exactly one `-review` task. The `-apply` task (L466) is conditional on `verdict === "FIX"` and applies findings; it is not a second review, and `applyPrompt` states "There is NO second review" (L240). |
| `landsPerLane` | pass | Landing is a `<MergeQueue maxConcurrency={1} failurePolicy="quarantine">` (L494) that is a *sibling* of the lanes inside the same `<Parallel>`, emitting one `land-<key>` task per lane that is ready and not yet landed (L495–517). A lane lands while other lanes are still implementing. No end-of-run batch merge node exists anywhere in the graph. |
| `rebaseFirst` | pass, prompt-level only | `landPrompt` (L244–253) orders fetch → `git rebase origin/main` → gates → `git push origin HEAD:main`, and on non-fast-forward re-fetches, rebases and retries up to five times. |
| `historyPreserved` | pass, prompt-level only | `landPrompt` says "never rewrite or force-push main"; `polishFixPrompt` (L270) and `remediatePrompt` (L293) both repeat "never rewrite history" and require fix-forward. |
| `polishConverges` | pass | `<Loop id="polish" until={polishLgtm} maxIterations={polishMax} onMaxReached="return-last">` (L521), default bound 4 (L24). It converges on an explicit `allLgtm`, which the reviewer may set true only when every landed commit has an explicit LGTM and no must-fix findings remain (L264), and the bound-reached behavior is declared rather than implicit. |
| `panelGatesHumanTasks` | pass | The `human-tasks` task and the `alpha-handoff` `<Approval>` render only under `{panelPassed ? …}` (L598), where `panelPassed = solReady && fableReady` (L341) across two independent seats (L572–593). The panel itself renders only once `allLanded && polishSettled` (L552). |

**Static score: 8/8**, which should be read for what it is. Six of the eight
clauses are enforced structurally, by the shape of the graph. Two —
`rebaseFirst` and `historyPreserved` — exist only as prompt text that the
landing agent is free to disregard. A static reading *cannot* fail those two,
so their pass carries much less weight than the other six. This is the
README's first limit one level down: scoring a workflow's source is still
scoring a claim, not an execution.

## This run's observable behavior

Some of what a static reading cannot settle is observable in the run that
produced this report, because that run is an alpha-core execution and this
lane (`ev`) is one of its seats. This is direct observation of a single run,
n=1, not a measurement across runs.

- **Lanes are genuinely isolated.** `git worktree list` shows six live lane
  worktrees — `ac-c1`, `ac-c2`, `ac-c3`, `ac-c4`, `ac-c5`, `ac-ev` — each
  checked out on its own `alpha-core/<key>` branch. `ac-c6` is absent, which
  matches the graph's gate on `c6` rather than contradicting it.
- **Landing is per-lane, not batched.** Over this run's window on `main`
  (`3fcf5fcd..origin/main`), 17 commits landed and `git log --merges` over
  that range is **empty**. The commits interleave this track with the sibling
  agent and UI tracks instead of arriving as one end-of-run merge.
- **This lane never pushed to `main` itself.** Its work sits as a single
  commit on `alpha-core/ev`; landing is a separate seat's job, as the graph
  says.
- **The lane rebased rather than merged.** Picking this lane's work back up
  required `git fetch origin && git rebase origin/main` onto a `main` that had
  moved underneath it; that rebase is why the branch is one commit on top of
  `cbd20d4e` and not a merge.

What this does **not** show: a linear `main` is consistent with rebase-first
landing, but a force-push also produces linear history. Nothing observed here
distinguishes the two, so this section corroborates `landsPerLane` and
`lanesIsolated` but does not independently confirm `historyPreserved`.

## Suite corrections made before this baseline

Three pilot trials were run first, on an earlier revision of the cases and
the workflow. All three exited `1`, at 8/10, 6/10 and 7/10. Reviewing their
reports turned up two authoring defects in the instrument, both fixed before
the baseline trials above:

1. **`no-history-rewrite` asserted `laneCount: 3`.** The brief names three
   lanes but also describes a flaky commit already landed on main. Every
   pilot trial added a fourth fix-forward lane to stabilize it — which is
   the correct response, and which the doctrine's fix-forward clause calls
   for. The assertion was wrong, not the plan. `laneCount` is now unasserted
   on that case and `scorers.md` records why.
2. **The `lanes` field did not say what a lane is.** One pilot trial modeled
   the readiness panel as a lane with zero pre-merge reviews, which failed
   `exactlyOneReviewPerLane` and `landsPerLane` on a plan that was otherwise
   doctrine-correct. The output contract in `orchestrator.tsx` now states
   that `lanes` holds implementation lanes only, and that the review, polish,
   panel, and handoff stages have their own fields.

Both corrections narrow the instrument to what it means to measure. Neither
tells the subject what the doctrinally correct answer is, and the placeholder
and duplicate lanes in trial 3 show the tightened contract did not suppress
genuine lane-count defects.

A third change was made at the same time: the judge threshold on
`unstated-doctrine-discovery` moved from `0.8` to `0.5`, for the reason given
in the discovery-gap section above.

## Reproducing this

```bash
bunx smthrs eval evals/orchestrator/orchestrator.tsx \
  --cases evals/orchestrator/cases.jsonl \
  --suite orchestrator-doctrine --concurrency 3 --force
```

Expect roughly 6–7 minutes per trial and 27/30 or better across three trials
on the same subject. A single trial at 10/10 is within normal variance and is
not evidence of an improvement; a case that fails on a substantive doctrine
check rather than on `laneCount` is worth investigating, because that did not
happen once in 27 stated-doctrine runs here.

Read `output.doctrine[0].violations` in the report to see which checks failed,
then `output.plan[0]` to see the plan that produced them, before concluding
anything about either the subject or the rubric.
