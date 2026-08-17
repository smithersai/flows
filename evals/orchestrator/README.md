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
   `main`, converging on an explicit LGTM. Reaching the bound is not
   permission to proceed: without the LGTM the run is not ready, nothing
   downstream starts, and fix-forward work continues or the run escalates to
   a human.
6. Human follow-up tasks are written only after an independent
   production-readiness panel of at least two seats returns a passing verdict
   under a binding pass rule. An advisory panel, or one a single seat can
   clear on its own, gates nothing.

## Files

| File | What it is |
| --- | --- |
| `orchestrator.tsx` | The workflow under eval. Puts the model under test in the orchestrator seat and grades the plan it returns. |
| `cases.jsonl` | Fourteen eval cases in the `smithers eval` JSONL case format. |
| `gradePlan.mjs` | The rubric as pure JavaScript: it reduces a plan to the twelve doctrine checks. Imported by `orchestrator.tsx`, and testable without launching an agent. |
| `gradePlan.test.mjs` | Negative regression tests for the rubric. Each breaks exactly one thing in a compliant plan and asserts that the one responsible check goes red. Run with `node --test`. |
| `scorers.md` | The rubric as prose: the twelve deterministic checks, the per-case assertions, and the judge rubrics. |
| `baseline-report.md` | Recorded baseline scores, and exactly what was and was not executed to produce them. Also scores `.smithers/workflows/alpha-core.tsx` — the runnable workflow implementing this doctrine — by a hand reading of its static graph, since running it once per case is not affordable. |

## Running the suite

From the repository root:

```bash
bunx smthrs eval evals/orchestrator/orchestrator.tsx \
  --cases evals/orchestrator/cases.jsonl \
  --suite orchestrator-doctrine \
  --concurrency 3 \
  --force \
  --judge-provider claude-code \
  --judge-model claude-opus-5
```

Pin `--judge-provider`. Left at its `auto` default the CLI picks the first
authenticated local agent, which makes judge verdicts depend on whichever
providers you happen to be logged into. It is also a real source of red: a
recorded run of this suite failed a case outright when the auto-detected
codex judge lost its connection mid-assertion, which is an infrastructure
fault reported as a behavior.

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
(`claude-code` by default) and for the two LLM-judge assertions.

Run the rubric's own tests, which need no agent provider and no network:

```bash
node --test evals/orchestrator/gradePlan.test.mjs
```

### How the subject is constrained

The subject is a reasoning-only planner, and the harness enforces that by
construction rather than by asking it in the prompt. `orchestrator.tsx` builds
the `claude-code` subject with:

| Option | Flag it emits | Why |
| --- | --- | --- |
| `yolo: false` | suppresses `--dangerously-skip-permissions` and `--permission-mode bypassPermissions` | Smithers defaults `yolo` to **true** (`BaseCliAgent`: `this.yolo = opts.yolo ?? true`). Left at the default the subject holds a live, auto-approving shell. |
| `tools: ""` | `--tools ''` | No built-in tools at all: no read, no write, no bash. |
| `settingSources: ""` | `--setting-sources ''` | No user or project settings, so no hooks or permissions from the ambient config. |
| `strictMcpConfig: true` | `--strict-mcp-config` | No MCP servers. |
| `cwd: SUBJECT_ROOT` | process cwd | An empty scratch directory outside every checkout. `BaseCliAgent` resolves `this.cwd ?? options?.rootDir ?? process.cwd()`, so without it the subject inherits the *repository* as its cwd. |

The `codex` subject has no "no tools" switch, so it gets `sandbox: "read-only"`
in the same empty directory — and `yolo: false` there is equally load-bearing,
because the default pushes `--dangerously-bypass-approvals-and-sandbox`, which
overrides the `--sandbox read-only` set alongside it.

Two things follow, and only these two. First, the subject cannot read this
repository, so it cannot recognize the alpha-core brief from the tree and
recite the answer instead of planning it — which is a real contamination this
suite has previously observed. Second, the subject cannot write, commit, or
push.

Both statements are about the subject. They are not a claim that a suite run
as a whole is side-effect-free: the LLM-judge agents are built by the CLI, not
by this workflow, and are not constrained. See Limits.

Verify it for a given smithers version rather than trusting this table:
construct the agent and inspect `buildCommand(...).args`. The flags above were
confirmed that way against `smthrs` 0.34.0; see `baseline-report.md`.

Neither constraint bounds what the subject *claims*. See Limits.

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

`doctrine` is deterministic JavaScript, and it lives in `gradePlan.mjs` rather
than in the workflow so it can be tested without launching an agent. It
reduces that plan to twelve booleans, plus the lane count, the lane keys, and
the prerequisite graph. Cases assert on those derived fields, so the pass/fail
rule is fixed code rather than a model's reading of prose. Two cases add an
LLM-judge assertion for qualities the booleans cannot express.

The prerequisite graph is reported as `dependencyEdges`, a sorted
`key:dep,dep;key:dep` string. Cases assert on that rather than on
`gatedLaneKeys` alone, because "lane `a4` is gated" is equally true of a plan
that gates `a4` on the wrong lane, on itself, or on a key that does not exist.
`dependenciesWellFormed` separately rejects those malformed graphs.

`scorers.md` documents every check and every per-case assertion, and
`gradePlan.test.mjs` proves each check can actually fail.

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

When you add a check to `gradePlan`, do three things in the same commit:

1. Add its name to `CHECK_ORDER` and its row to the `scorers.md` table. The
   rubric table is documentation of that function and drifts silently
   otherwise.
2. Add a negative test to `gradePlan.test.mjs` that breaks exactly that one
   thing and asserts the check goes red while the others stay green. A check
   nothing can fail is not a check.
3. Ask whether an existing case already passes with the new defect present. If
   one does, add a case that isolates it. That is why
   `self-review-temptation`, `stacked-branch-temptation`,
   `advisory-panel-temptation`, and `polish-bound-exhaustion` exist: each
   scenario satisfies its neighbouring check while violating the doctrine.

## Limits

Read these before acting on a score.

- **It scores a plan, not an execution.** The subject reports the
  orchestration it says it would run. Nothing here observes an actual run, so
  every field is a claim. A model can answer `forcePushesMain: false` and
  still force-push when it holds a real shell. This is the suite's largest
  limit and no amount of rubric work removes it; closing it means grading a
  real run's git history and task graph, which this suite does not do.
- **Thirteen of fourteen cases state the doctrine.** Those cases measure
  compliance under pressure, not judgment. A model that follows any
  instruction it is given scores well on them. `unstated-doctrine-discovery`
  is the only case that probes judgment, and one case is not a measurement of
  it.
- **The subject is constrained, not ignorant.** Cutting off tools and pinning
  the cwd outside every checkout stops the subject from *reading* this
  repository during a run. It does not remove whatever it already knows from
  training or from a system prompt. A model that has seen this doctrine before
  can still recite it. The constraint closes one contamination channel and
  leaves that one open.
- **The expected lane counts are authored, not derived.** Each brief was
  written with a specific decomposition in mind and the case pins
  `laneCount` to it. A different but defensible decomposition scores as a
  failure. Read the plan in the report before believing a `laneCount` red.
- **Small sample, non-deterministic subject.** Fourteen cases per trial
  against a sampling model. Treat a single trial's score as an estimate; the
  baseline report records three trials for this reason.
- **The judges are the same family as the subject.** Both judge assertions
  run on an agent provider that may be the same vendor as the model under
  test. Correlated blind spots are not controlled for.
- **The judge agents are not constrained the way the subject is.** The
  `--tools ''` / pinned-cwd treatment above applies to the subject, which
  `orchestrator.tsx` constructs. The LLM-judge agents are constructed by the
  `smithers eval` CLI, which exposes only `--judge-provider` and
  `--judge-model` — no way to disable their tools or move their working
  directory. They therefore run with smithers' default `yolo: true` in the
  repository root. This does not contaminate a score, because a judge never
  produces a scored plan and only reads the plan text handed to it, but it
  does mean a suite run is not provably side-effect-free end to end. Verified
  against `smthrs` 0.34.0.
- **Pressure cases are single-turn.** Real deviation pressure arrives
  repeatedly, from a reviewer, a failing gate, and a human, over hours. One
  paragraph in a planning prompt is a weak proxy for that.
- **`cases.jsonl` cannot carry `#` comments.** The `smithers eval` CLI's JSONL
  loader rejects any line that is not a JSON object, though the shared
  `parseEvalDataset` helper documented in the Smithers bundle does skip
  `#` lines. Keep annotations in each case's `metadata` object instead; every
  case here carries a `probe` field explaining what it is designed to catch.
