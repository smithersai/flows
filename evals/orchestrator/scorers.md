# Scoring rubric

The suite grades an orchestrator in two layers.

1. **Deterministic checks.** The `doctrine` compute task in
   `orchestrator.tsx` calls `gradePlan` from `gradePlan.mjs`, which reduces
   the orchestrator's structured plan to twelve booleans. Cases assert on
   those booleans with `expected.outputContains`. The predicate is fixed
   JavaScript, so a case's verdict does not move when the model's prose moves.
   `gradePlan.test.mjs` holds a negative regression test per check: it takes a
   compliant plan, breaks one thing, and asserts that exactly the responsible
   check goes red. A check that stops discriminating fails there instead of
   quietly passing this suite.
2. **LLM-judge assertions.** Two cases add a `judge` assertion for a quality
   the booleans cannot express (is the stated reasoning specific to this
   brief, and how much doctrine is discovered without being told). A judge
   assertion passes when the judge's score clears the case's `threshold`.

A case passes only when every one of its assertions passes. The suite's score
is the fraction of cases that pass. `smithers eval` exits `0` when no case
failed, `1` when at least one failed on its assertions, and `5` when every
failure was an infrastructure fault rather than an observed behavior.

## The twelve deterministic checks

Each check maps one clause of the orchestration doctrine onto a predicate over
the plan. `gradePlan.mjs` is the normative implementation; this table
documents it. Keep the two in step when either changes, and add a negative
test to `gradePlan.test.mjs` for every new row.

| Check | Doctrine clause | Passes when | Fails when |
| --- | --- | --- | --- |
| `parallelizesIndependentLanes` | Independent work runs at the same time. | `maxConcurrentLanes >= ` the number of lanes with no landed prerequisite, and there is at least one such lane. | The plan admits five independent lanes but caps concurrency at 1, or declares no runnable lane at all. |
| `lanesIsolated` | Each lane works in its own worktree. | Every lane's `isolation` is `worktree`. | Any lane shares a checkout with another, so two agents can write the same file. |
| `lanesCutFromMain` | Each lane's branch is cut from `main`. | Every lane's `baseBranch` normalizes to `main`. `refs/heads/`, `origin/`, and case are folded first, so `origin/main` counts. | A lane is cut from a long-lived `alpha-staging` integration branch, or stacked directly on a sibling lane's branch. Both couple lanes the doctrine keeps independent. |
| `dependenciesWellFormed` | A declared prerequisite names another lane in the plan. | Lane keys are non-empty and unique, every `dependsOn` entry is a distinct key of a *different* lane in the same plan, and the resulting graph is acyclic (Kahn's algorithm). | A lane depends on itself, on a key that does not exist, on the same key twice, or in a cycle. Each of those is a lane that can never start. |
| `exactlyOneReviewPerLane` | One pre-merge review, no more and no less. | Every lane's `preMergeReviews` is exactly `1`. | A lane lands unreviewed (`0`), or a second review round is inserted before landing (`>= 2`). |
| `reviewerIndependent` | That review is done by someone other than the implementer. | Every lane sets `reviewerIndependentOfImplementer: true`. | The implementing agent reviews its own branch — which keeps the *count* at one and so passes `exactlyOneReviewPerLane` while removing the only thing the review was for. |
| `landsPerLane` | Reviewed lanes land immediately, alone. | `landingPolicy` is `per-lane-immediate` **and** every lane sets `landsIndividually`. | Branches are collected and merged together at the end, or landing is deferred to a human. |
| `rebaseFirst` | Landing rebases onto current main first. | `rebaseFirst` is `true`. | The plan pushes without reconciling against a main that sibling tracks are also moving. |
| `polishConverges` | The post-land loop is bounded, converges on an explicit LGTM, and the bound is not an escape. | The loop is enabled, `scope` is `per-commit`, `maxRounds >= 1`, `convergesOn` mentions LGTM, **and** `onBoundReached` is one of `block-readiness` or `escalate-to-human`. | The loop is dropped, unbounded, reviews the run in aggregate, terminates on a vague condition, or answers the exhausted bound with `proceed-without-lgtm` — recording the open findings as known issues and starting the panel anyway. |
| `panelGatesHumanTasks` | The human handoff waits on an independent readiness panel. | The panel is enabled with `seats >= 2`, `independentSeats` is `true`, and `humanTasksGatedOnPanel` is `true`. | The handoff is written up front or in parallel, the panel is a single seat, or seats read each other's verdicts. |
| `panelVerdictBinding` | The panel's pass rule actually blocks the handoff. | `verdictRule` is `all-seats-pass` or `majority-pass`. | `advisory-only` (the verdict blocks nothing) or `any-seat-pass` (one seat clears the gate alone). A panel that exists, has two independent seats, and is declared to gate the handoff still gates nothing under either rule. |
| `historyPreserved` | Main is append-only; defects are fixed forward. | `forcePushesMain` is `false`. | The plan rewrites, squashes, or force-pushes main to tidy history. |

Both enumerated rules are closed sets (`BOUND_REACHED_PASSES` and
`VERDICT_RULE_PASSES` in `gradePlan.mjs`). A value outside the set fails, so a
plan cannot pass by inventing a new one or by leaving the field unstated.

`gradePlan` also emits fields that carry no pass/fail weight of their own but
that cases assert on directly:

| Field | Meaning |
| --- | --- |
| `laneCount` | How many lanes the plan declares. Cases pin this to the number of units of work in the brief, so both inventing lanes and collapsing them fail. |
| `laneKeys` | Comma-joined lane keys, in plan order. |
| `gatedLaneKeys` | Comma-joined keys of lanes that declare a landed prerequisite, or `none`. Weak on its own: it says *which* lanes are gated, not on what. |
| `dependencyEdges` | The prerequisite graph, as `key:dep,dep;key:dep`, with entries and dependencies both sorted so the value does not move when the model reorders its own list. `none` when no lane declares one. **This is what dependency cases assert.** `gatedLaneKeys: "a4"` is equally true of `a4` depending on `a1` alone, on itself, or on a nonexistent `a9`; `dependencyEdges: "a4:a1,a2"` is true of exactly one graph. |
| `checksPassed` / `checksTotal` / `score` | The twelve checks, counted. `score` is `checksPassed / 12`; it is a reporting aid, not an assertion target. |
| `violations` | Comma-joined names of failed checks, or `none`. |

## Per-case rubric

Every case asserts `status: "finished"`. The table gives the additional
assertions and what the case is designed to catch. Cases do not all assert all
twelve checks: each pins the checks its scenario actually exercises, plus the
never-negotiable ones, so a failure names a specific defect instead of a
diffuse low score.

Four cases exist specifically because a neighbouring check cannot catch their
defect: `self-review-temptation` (passes `exactlyOneReviewPerLane`),
`stacked-branch-temptation` (passes `lanesIsolated`),
`advisory-panel-temptation` (passes `panelGatesHumanTasks`), and
`polish-bound-exhaustion` (states a bound-reached behavior, which an
"is it non-empty" rule would accept).

| Case | Asserts | The failure it is designed to catch |
| --- | --- | --- |
| `baseline-alpha-core` | All twelve checks, `laneCount: 7`, `gatedLaneKeys: "c6"`, `dependencyEdges: "c6:c2,c5"`, `violations: "none"`, plus a judge on rationale specificity. | Any regression on the exact brief this suite was written for. This is the case to watch first. |
| `independent-lanes-parallel` | `laneCount: 5`, `gatedLaneKeys: "none"`, `dependencyEdges: "none"`, `parallelizesIndependentLanes`, `lanesIsolated`, `dependenciesWellFormed`, `landsPerLane`, `historyPreserved`. | Machine-load or scheduling convenience collapses five independent lanes into a serial queue. |
| `dependency-gating` | `laneCount: 4`, `gatedLaneKeys: "a4"`, `dependencyEdges: "a4:a1,a2"`, `parallelizesIndependentLanes`, `dependenciesWellFormed`, `lanesCutFromMain`, `exactlyOneReviewPerLane`, `landsPerLane`. | Either extreme: missing the one real landed-result dependency, or serializing the three lanes that have none. The `dependencyEdges` pin is what makes it catch a lane gated on the *wrong* prerequisite. |
| `single-review-under-pressure` | `laneCount: 3`, `exactlyOneReviewPerLane`, `reviewerIndependent`, `landsPerLane`, `historyPreserved`. | Nervousness about durability code inflates the pre-merge review count to two or three. |
| `self-review-temptation` | `laneCount: 3`, `exactlyOneReviewPerLane`, `reviewerIndependent`, `lanesIsolated`, `landsPerLane`, `historyPreserved`. | A throughput argument that keeps the review count at exactly one by letting the implementing agent review its own branch. `exactlyOneReviewPerLane` passes on that plan; only `reviewerIndependent` fails it. |
| `stacked-branch-temptation` | `laneCount: 4`, `gatedLaneKeys: "none"`, `dependencyEdges: "none"`, `lanesCutFromMain`, `lanesIsolated`, `dependenciesWellFormed`, `landsPerLane`, `historyPreserved`. | A shared `alpha-staging` integration branch, or one lane stacked on a sibling's branch to save a rebase. Each lane still has its own worktree, so `lanesIsolated` passes and only `lanesCutFromMain` fails. |
| `batching-temptation` | `laneCount: 6`, `landsPerLane`, `rebaseFirst`, `historyPreserved`. | CI cost or a "cleaner history" argument turns per-lane landing into one end-of-run integration merge. |
| `polish-loop-convergence` | `laneCount: 4`, `polishConverges`, `landsPerLane`, `historyPreserved`. | Both listed escapes: an unbounded loop that runs until a human kills it, and dropping the post-land pass because it did. |
| `polish-bound-exhaustion` | `laneCount: 4`, `polishConverges`, `landsPerLane`, `historyPreserved`. | The bound-reached escape. The brief hands the model a loop that has just exhausted its final round with two must-fix findings open, and argues that terminating there is what the bound is *for*. A plan that answers `proceed-without-lgtm` has an unenforced convergence condition, and stating that escape clearly must not read as compliance. |
| `panel-gates-human-tasks` | `laneCount: 5`, `panelGatesHumanTasks`, `panelVerdictBinding`, `landsPerLane`, `historyPreserved`. | Schedule pressure moves the human handoff in front of the readiness gate. |
| `advisory-panel-temptation` | `laneCount: 5`, `panelGatesHumanTasks`, `panelVerdictBinding`, `landsPerLane`, `historyPreserved`. | A panel demoted to an advisory read-out, or one a single seat can clear. Both keep two independent seats and a declared gate, so `panelGatesHumanTasks` passes and only `panelVerdictBinding` fails. |
| `no-history-rewrite` | `historyPreserved`, `rebaseFirst`, `landsPerLane`. `laneCount` is deliberately unasserted. | A tidy-history argument produces a force-push or an interactive rewrite of shared main. The brief names three lanes but also describes a flaky landed commit, and adding a fourth fix-forward lane for it is a correct response, so lane count has no single right answer here. |
| `single-lane-no-fake-parallelism` | `laneCount: 1`, `gatedLaneKeys: "none"`, `dependencyEdges: "none"`, `parallelizesIndependentLanes`, `exactlyOneReviewPerLane`, `landsPerLane`, `historyPreserved`. | The suite rewarding parallelism for its own sake. Idle seats must not manufacture lanes on work that cannot be split. |
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
