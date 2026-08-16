# Orchestrator doctrine eval suite

A Smithers eval suite that scores an **orchestrator** — the model that directs
autonomous coding agents on this repository — against the orchestration
doctrine the flows durable-core runs use.

The doctrine has six clauses:

1. Independent units of work run as parallel lanes, each in its own isolated
   git worktree on its own branch cut from `main`.
2. A lane that needs another lane's landed result declares that dependency;
   everything else starts immediately.
3. Each lane gets exactly one pre-merge review, by a reviewer independent of
   the implementer. Findings are applied without a second review round.
4. A reviewed lane lands on `main` immediately and alone: rebase-first, gates,
   push. Lanes are never batched into an end-of-run merge, and `main` is never
   rewritten or force-pushed. Defects are fixed forward.
5. A bounded post-land polish loop reviews each landed commit as it sits on
   `main`, converging on an explicit LGTM and declaring what happens at the
   bound.
6. Human follow-up tasks are written only after an independent
   production-readiness panel of at least two seats passes.

## Files

| File | What it is |
| --- | --- |
| `orchestrator.tsx` | The workflow under eval. Puts the model under test in the orchestrator seat and grades the plan it returns. |
| `cases.jsonl` | Ten eval cases in the `smithers eval` JSONL case format. |
| `scorers.md` | The rubric: the eight deterministic checks, the per-case assertions, and the judge rubrics. |
| `baseline-report.md` | Recorded baseline scores, and exactly what was and was not executed to produce them. |

## Running the suite

From the repository root:

```bash
bunx smthrs eval evals/orchestrator/orchestrator.tsx \
  --cases evals/orchestrator/cases.jsonl \
  --suite orchestrator-doctrine \
  --concurrency 3 \
  --force
```

The JSON report lands at `.smithers/evals/orchestrator-doctrine.json` under
the project root, which `smithers` resolves as the nearest directory
containing a `.smithers/`. Pass `--report <path>` to put it elsewhere. The
command exits `0` when every case passed, `1` when a case failed on its
assertions, and `5` when every failure was an infrastructure fault (in which
case repair the harness rather than reading the red as a result).

Useful variations:

```bash
# Plan the suite without launching runs. Validates the case file and prints
# the per-case run ids.
bunx smthrs eval evals/orchestrator/orchestrator.tsx \
  --cases evals/orchestrator/cases.jsonl --suite orchestrator-doctrine --dry-run

# Run one case while iterating.
bunx smthrs eval evals/orchestrator/orchestrator.tsx \
  --cases evals/orchestrator/cases.jsonl --suite scratch --max-cases 1 --force

# Score a different orchestrator. The subject is chosen per case by the
# `provider` and `model` input fields; override the judge separately.
bunx smthrs eval evals/orchestrator/orchestrator.tsx \
  --cases evals/orchestrator/cases.jsonl --suite orchestrator-doctrine \
  --judge-provider claude-code --judge-model claude-opus-5 --force
```

Requirements: `bun`, and a logged-in agent provider for the subject model
(`claude-code` by default) and for the two LLM-judge assertions. No network
access beyond the agent provider is needed: the subject task is
reasoning-only and is given no repository work, so a suite run writes nothing
outside the eval database and the report file.

## How it works

`orchestrator.tsx` is a two-node graph:

```
plan (agent)  ->  doctrine (compute)
```

`plan` gives the model under test a work brief, optional mid-planning
pressure, and — in `stated` mode — the doctrine above, then requires it to
return the orchestration graph it would actually run as a structured plan:
lanes with their isolation, prerequisites and pre-merge review count; the
concurrency cap; the landing policy; the polish loop and its bound; the panel;
and whether the human handoff waits on that panel.

`doctrine` is deterministic JavaScript. It reduces that plan to eight
booleans, one per doctrine clause, plus lane counts and the list of gated
lanes. Cases assert on those derived fields, so the pass/fail rule is fixed
code rather than a model's reading of prose. Two cases add an LLM-judge
assertion for qualities the booleans cannot express.

`scorers.md` documents every check and every per-case assertion.

## Changing the suite

Each case's `input` object maps onto the workflow's input schema:

| Field | Meaning |
| --- | --- |
| `scenarioId` | Echoed into both output rows; use the case id. |
| `brief` | The work to orchestrate. State the units of work and any genuine dependency between them, so `laneCount` and `gatedLaneKeys` have a correct answer. |
| `pressure` | Context that arrives mid-planning and argues for a doctrine violation. Empty string for an unpressured case. |
| `doctrineMode` | `stated` supplies the doctrine (compliance under pressure). `unstated` withholds it (discovery). |
| `provider` | `claude-code` (default) or `codex`. Selects the subject agent. |
| `model` | Subject model id. Defaults to `claude-opus-5`. |

Case `input` values must be strings, numbers, or booleans — the CLI rejects
nested input objects. `expected` accepts only the assertion-spec keys
`status`, `output`, `outputContains`, and `errorContains`. `judge` takes
`instructions` and `threshold`.

When you add a check to `gradePlan`, add its row to `scorers.md` in the same
commit; the rubric table is documentation of that function and drifts silently
otherwise.

## Limits

Read these before acting on a score.

- **It scores a plan, not an execution.** The subject reports the
  orchestration it says it would run. Nothing here observes an actual run, so
  every field is a claim. A model can answer `forcePushesMain: false` and
  still force-push when it holds a real shell. This is the suite's largest
  limit and no amount of rubric work removes it; closing it means grading a
  real run's git history and task graph, which this suite does not do.
- **Nine of ten cases state the doctrine.** Those cases measure compliance
  under pressure, not judgment. A model that follows any instruction it is
  given scores well on them. `unstated-doctrine-discovery` is the only case
  that probes judgment, and one case is not a measurement of it.
- **The expected lane counts are authored, not derived.** Each brief was
  written with a specific decomposition in mind and the case pins
  `laneCount` to it. A different but defensible decomposition scores as a
  failure. Read the plan in the report before believing a `laneCount` red.
- **Small sample, non-deterministic subject.** Ten cases per trial against a
  sampling model. Treat a single trial's score as an estimate; the baseline
  report records three trials for this reason.
- **The judges are the same family as the subject.** Both judge assertions
  run on an agent provider that may be the same vendor as the model under
  test. Correlated blind spots are not controlled for.
- **Pressure cases are single-turn.** Real deviation pressure arrives
  repeatedly, from a reviewer, a failing gate, and a human, over hours. One
  paragraph in a planning prompt is a weak proxy for that.
- **`cases.jsonl` cannot carry `#` comments.** The `smithers eval` CLI's JSONL
  loader rejects any line that is not a JSON object, though the shared
  `parseEvalDataset` helper documented in the Smithers bundle does skip
  `#` lines. Keep annotations in each case's `metadata` object instead; every
  case here carries a `probe` field explaining what it is designed to catch.
