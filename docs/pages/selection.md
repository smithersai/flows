# Probabilistic Selection

Source: `docs/specs/Concepts/Probabilistic Selection.md` (`status: draft`).

The engine's exact-dependency graph knows which files a step read and which
inputs it declared, and that is enough to know what must re-run and what is
safe to skip — for builds and tests. It is not enough for a flow like "update
the engine docs when the engine changes": no declared input connects the docs
flow to the engine source, so today that flow runs on every change, or on
none.

Probabilistic Selection is the seam that closes that gap without weakening
the guarantee the exact-dependency graph already gives. It learns, from
recorded history, which changes tend to affect which flows, and lets those
guesses do exactly three things: suggest extra work, postpone work that
almost never fails, and order the queue.

**A guess may schedule work. Only a real dependency edge decides what is
cached, correct, or up to date.**

## The motivating picture

The spec illustrates the idea with a plan card. You edit
`packages/engine/src/PlanScheduler.ts` and plan a review.

Today:

```
cached    read-pr
run       build
run       engine-tests
run       lint-docs            ← runs every time; failed 3× in two years
                                (and update-engine-docs is not here at all —
                                 no file dependency reaches it)
```

With selection informing the plan:

```
cached    read-pr
run       build
run       engine-tests
deferred  lint-docs            fail likelihood 0.03 · runs in the guess-free pass
proposed  update-engine-docs   engine/** changes preceded doc edits in 41 of 50 merges
```

`deferred` is not run now; it is queued for a later guess-free pass that
repays it with no guessing. `proposed` is extra work a guess suggests — an
ordinary plan row, so approving the plan is what admits it. Neither row is
rendered by v1 — the plan card in this picture is future work (see
[What v1 does not ship](#what-v1-does-not-ship)). What v1 ships is the
underlying seam and the journal records a card like this would be built
from — `flows.engine.selection-deferred` and `flows.engine.selection-proposed`
— plus the `"deferred"` scheduling outcome itself.

## The three allowed actions

| Action | What it means | Worst case when wrong |
| --- | --- | --- |
| **Propose** | Record a candidate row for a flow no real dependency reaches | An unneeded suggestion sits unapproved |
| **Defer** | Postpone a low-risk sink to a later guess-free pass | The failure surfaces late; the miss becomes the training signal |
| **Order** | Run likely-to-fail steps first, inside the scheduler's existing priority | A worse order; the scheduler's built-in aging still prevents starvation |

v1 ships `Propose` and `Defer` as scheduler-visible verdicts, alongside the
pass-through `Admit`. `Order` rides the plan's existing `priority` field
rather than a fourth verdict — `Selection` does not add its own ordering
channel.

## Why only sinks are deferrable

A sink is a node nothing else in the plan depends on — a test, a lint pass, a
doc check. Deferring a step something depends on would block or corrupt its
consumers, so v1 makes that structurally impossible: the scheduler only ever
offers a verdict to a sink candidate. A `Defer` or `Propose` verdict that
names a non-sink is not honored — it is ignored and journaled as an
inconsistency observation, not executed as a silent no-op. Meta's test
selection draws the same line, for the same reason: tests are sinks.

## Recertification debt

A deferred step is a debt, not a decision. It is journaled with the guess
that caused it, and the `Selection.debt` query lists every open one — node, key,
edge, likelihood, and journal provenance — so a guess-free pass can execute
exactly what was deferred.

v1 ships the primitives a recertification pass is built from: the
`Selection.debt` query and a run-level override that forces every verdict to
`Admit` for one run, itself journaled, the way `--fresh` ignores the cache.
v1 does not ship a scheduled system flow that runs that pass automatically —
a nightly or per-merge "recertify" flow is future work layered on top of
these primitives, not part of this module.

When a guess is wrong, the recertification pass is where that surfaces: the
deferred step runs for real, and the miss becomes the training signal for the
belief that deferred it. Training and confidence decay are themselves future
work — see below.

## Prior art

Every production system that does this keeps a deterministic dependency
graph and puts the learned model *above* it, where it can only select, order,
or flag — never decide correctness.

| System | The model decides | Correctness kept by |
| --- | --- | --- |
| Meta Predictive Test Selection | Which tests, among those the build graph already says are affected, to run now | Skipped tests still run later on trunk; misses retrain the model |
| Meta Diff Risk Score | How likely a change is to cause an incident | Advisory only, human-overridable |
| Uber SubmitQueue | Which merge builds to start speculatively, in what order | The queue's deterministic serialization; a wrong guess only wastes compute |

Probabilistic Selection follows the same split: a deterministic core below —
the exact-dependency graph, the step cache, the plan — with learned advice
above it. One deviation from Meta's design: Meta's model only prunes within
what the build graph already selected, while `Propose` here also suggests
work the graph cannot see, because for agentic flows a guess is sometimes the
only edge that exists at all.

## What v1 ships

- `Selection.select`, a pure function of a pinned `BeliefSnapshot`: `Admit` /
  `Defer` / `Propose` verdicts that never touch a step's key or cache row.
- `layerNoop` — admits everything — as the default. Installing the package
  changes nothing until a layer is chosen; this is the hard compatibility
  bar.
- `layerHeuristic` — pure, deterministic glob matching of changed paths
  against `SuspectedEdge.scope`, no IO, no model calls.
- The `PlanScheduler` integration: only sink candidates are ever consulted; a
  `Defer` writes no cache row and settles its node as the new `"deferred"`
  outcome, distinct from `clean`/`built` and from the existing
  dependency-failure `"skipped"`; a `Propose` is journaled, not
  auto-appended; a run-level override treats every verdict as `Admit`.
- The `Selection.debt` query.

See `packages/engine-store/README.md` for the API and `docs/reference/engine-store.md`
for the exact contract, including the four laws every layer is held to.

## What v1 does not ship

- Rendering `deferred` / `proposed` rows in a plan card, or in any UI.
- A model-backed `Selection` layer — `layerHeuristic` is the only shipped
  non-noop layer, and this package has no model dependency.
- Belief training or confidence decay from recertification outcomes.
- A read-set proposer for agent steps.
- Plan-level risk scoring.
- Automatically appending a `Propose` verdict as a plan node — v1 records and
  surfaces proposals; admitting one into the plan is a human or a caller's
  action.
