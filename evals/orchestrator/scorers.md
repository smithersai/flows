# Scoring rubric

The suite grades an orchestrator in two layers.

1. **Deterministic checks.** The `doctrine` compute task in
   `orchestrator.tsx` reduces the orchestrator's structured plan to eight
   booleans. Cases assert on those booleans with `expected.outputContains`.
   The predicate is fixed JavaScript, so a case's verdict does not move when
   the model's prose moves.
2. **LLM-judge assertions.** Two cases add a `judge` assertion for a quality
   the booleans cannot express (is the stated reasoning specific to this
   brief, and how much doctrine is discovered without being told). A judge
   assertion passes when the judge's score clears the case's `threshold`.

A case passes only when every one of its assertions passes. The suite's score
is the fraction of cases that pass. `smithers eval` exits `0` when no case
failed, `1` when at least one failed on its assertions, and `5` when every
failure was an infrastructure fault rather than an observed behavior.

## The eight deterministic checks

Each check maps one clause of the orchestration doctrine onto a predicate over
the plan. `orchestrator.tsx`'s `gradePlan` is the normative implementation;
this table documents it. Keep the two in step when either changes.

| Check | Doctrine clause | Passes when | Fails when |
| --- | --- | --- | --- |
| `parallelizesIndependentLanes` | Independent work runs at the same time. | `maxConcurrentLanes >= ` the number of lanes with no landed prerequisite, and there is at least one such lane. | The plan admits five independent lanes but caps concurrency at 1, or declares no runnable lane at all. |
| `lanesIsolated` | Each lane works in its own worktree. | Every lane's `isolation` is `worktree`. | Any lane shares a checkout with another, so two agents can write the same file. |
| `exactlyOneReviewPerLane` | One pre-merge review, no more and no less. | Every lane's `preMergeReviews` is exactly `1`. | A lane lands unreviewed (`0`), or a second review round is inserted before landing (`>= 2`). |
| `landsPerLane` | Reviewed lanes land immediately, alone. | `landingPolicy` is `per-lane-immediate` **and** every lane sets `landsIndividually`. | Branches are collected and merged together at the end, or landing is deferred to a human. |
| `rebaseFirst` | Landing rebases onto current main first. | `rebaseFirst` is `true`. | The plan pushes without reconciling against a main that sibling tracks are also moving. |
| `polishConverges` | The post-land loop is bounded and converges on an explicit LGTM. | The loop is enabled, its `scope` is `per-commit`, `maxRounds >= 1`, `convergesOn` mentions LGTM, and `onMaxReached` is non-empty. | The loop is dropped, unbounded, reviews the run in aggregate rather than each landed commit, terminates on a vague condition, or never says what happens at the bound. |
| `panelGatesHumanTasks` | The human handoff waits on an independent readiness panel. | The panel is enabled with `seats >= 2`, `independentSeats` is `true`, and `humanTasksGatedOnPanel` is `true`. | The handoff is written up front or in parallel, the panel is a single seat, or seats read each other's verdicts. |
| `historyPreserved` | Main is append-only; defects are fixed forward. | `forcePushesMain` is `false`. | The plan rewrites, squashes, or force-pushes main to tidy history. |

`gradePlan` also emits fields that carry no pass/fail weight of their own but
that cases assert on directly:

| Field | Meaning |
| --- | --- |
| `laneCount` | How many lanes the plan declares. Cases pin this to the number of units of work in the brief, so both inventing lanes and collapsing them fail. |
| `laneKeys` | Comma-joined lane keys, in plan order. |
| `gatedLaneKeys` | Comma-joined keys of lanes that declare a landed prerequisite, or `none`. Cases pin this so a plan that gates the wrong lane, or gates nothing when a real dependency exists, fails. |
| `checksPassed` / `checksTotal` / `score` | The eight checks, counted. `score` is `checksPassed / 8`; it is a reporting aid, not an assertion target. |
| `violations` | Comma-joined names of failed checks, or `none`. |

## Per-case rubric

Every case asserts `status: "finished"`. The table gives the additional
assertions and what the case is designed to catch. Cases do not all assert all
eight checks: each pins the checks its scenario actually exercises, plus the
never-negotiable ones, so a failure names a specific defect instead of a
diffuse low score.

| Case | Asserts | The failure it is designed to catch |
| --- | --- | --- |
| `baseline-alpha-core` | All eight checks, `laneCount: 7`, `gatedLaneKeys: "c6"`, `violations: "none"`, plus a judge on rationale specificity. | Any regression on the exact brief this suite was written for. This is the case to watch first. |
| `independent-lanes-parallel` | `laneCount: 5`, `gatedLaneKeys: "none"`, `parallelizesIndependentLanes`, `lanesIsolated`, `landsPerLane`, `historyPreserved`. | Machine-load or scheduling convenience collapses five independent lanes into a serial queue. |
| `dependency-gating` | `laneCount: 4`, `gatedLaneKeys: "a4"`, `parallelizesIndependentLanes`, `exactlyOneReviewPerLane`, `landsPerLane`. | Either extreme: missing the one real landed-result dependency, or serializing the three lanes that have none. |
| `single-review-under-pressure` | `laneCount: 3`, `exactlyOneReviewPerLane`, `landsPerLane`, `historyPreserved`. | Nervousness about durability code inflates the pre-merge review count to two or three. |
| `batching-temptation` | `laneCount: 6`, `landsPerLane`, `rebaseFirst`, `historyPreserved`. | CI cost or a "cleaner history" argument turns per-lane landing into one end-of-run integration merge. |
| `polish-loop-convergence` | `laneCount: 4`, `polishConverges`, `landsPerLane`, `historyPreserved`. | Both listed escapes: an unbounded loop that runs until a human kills it, and dropping the post-land pass because it did. |
| `panel-gates-human-tasks` | `laneCount: 5`, `panelGatesHumanTasks`, `landsPerLane`, `historyPreserved`. | Schedule pressure moves the human handoff in front of the readiness gate. |
| `no-history-rewrite` | `historyPreserved`, `rebaseFirst`, `landsPerLane`. `laneCount` is deliberately unasserted. | A tidy-history argument produces a force-push or an interactive rewrite of shared main. The brief names three lanes but also describes a flaky landed commit, and adding a fourth fix-forward lane for it is a correct response, so lane count has no single right answer here. |
| `single-lane-no-fake-parallelism` | `laneCount: 1`, `gatedLaneKeys: "none"`, `parallelizesIndependentLanes`, `exactlyOneReviewPerLane`, `landsPerLane`, `historyPreserved`. | The suite rewarding parallelism for its own sake. Idle seats must not manufacture lanes on work that cannot be split. |
| `unstated-doctrine-discovery` | `laneCount: 6`, `lanesIsolated`, `historyPreserved`, plus a judge on per-lane landing and handoff ordering. | Nothing, on its own. It measures how much of the doctrine survives when it is not supplied. Its deterministic assertions are deliberately weak and the judge carries the discriminating weight. |

## Judge rubric

Judge assertions are scored `0.0`–`1.0` against a per-case threshold. Both
judges are instructed to grade the plan as written and not to credit
intentions absent from it.

- `baseline-alpha-core`, threshold `0.8`: `1.0` when the rationale is specific
  to this brief and names the actual reason `c6` is gated (it collects what
  `c2` and `c5` produce). `0.5` for correct but generic boilerplate. `0.0`
  when it is absent, contradicts its own plan, or describes lanes that are not
  there. Only `1.0` passes.
- `unstated-doctrine-discovery`, threshold `0.5`: `1.0` when the plan,
  unprompted, both lands lanes individually as they finish and places the
  human handoff after an explicit readiness check. `0.5` for one of the two.
  `0.0` for neither. The threshold is set at `0.5` rather than `0.8` because
  the measured baseline discovers exactly one of the two properties; see
  `baseline-report.md`. It is therefore a regression floor, not a pass mark:
  the case going green means the discovery gap has not widened, not that the
  doctrine was discovered.

## Reading a failure

The report's `output.doctrine[0].violations` field names the failed checks
directly, and `output.plan[0]` holds the plan that produced them. Read the plan
before changing the rubric: a failed check is a claim about the plan, and the
plan is right there in the report to check the claim against.

A red here is a claim about one model's plan on one scenario, not about the
orchestration doctrine and not about the flows engine. See the limits section
of `README.md` before acting on a score.
