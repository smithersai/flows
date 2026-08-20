# The flows agent eval suite

An offline, deterministic evaluation of **our** agent: the loop in
`@smthrs/agent`, reached through its public API. It replaces the removed
`evals/orchestrator` suite, which scored an external CLI agent's planning prose
and could not run from a checkout at all.

That removal took twelve doctrine checks with it. They graded orchestration
doctrine for an external CLI — how a plan was phrased, staged, and handed off —
and they were retired with the subject they described, not relocated here. This
suite grades our own loop, so none of the twelve has an equivalent to move.

## Running it

From the repository root:

```bash
bun evals/agent/run.ts
```

Bun, not node: see [Updating the baseline](#updating-the-baseline). The suite
refuses any other runtime with exit `5` rather than reporting a red it cannot
justify.

No API key, no network, no global CLI install. The suite exits `0` when every
case matched the committed baseline and cleared the gate, `1` when a score
dropped or moved or an observation went missing, and `5` when the gate could not
decide — a `5` is a broken harness, not a result.

Two flags:

| Flag       | Effect                                                                |
| ---------- | --------------------------------------------------------------------- |
| `--update` | Rewrites `baseline.json` from this run.                               |
| `--json`   | Prints the full machine-readable regression report when a run drifts. |

## What it measures

Ten cases. Each one is a whole agent run: the real cell loop, the real QuickJS
sandbox, the real registry-backed call bridge, and the real structured-output
boundary, executing over `FlowEngine.layerMemory` — the engine's in-process
volatile runtime, not the durable SQLite one a deployed host uses. Three things
around the loop are supplied by the suite: the `Model` behind `SeatResolver`,
which answers with recorded cells; the `Route` it seals against, which never
leaves the process; and the `Registry`, which is empty. That is what makes the
suite deterministic, and it is also the limit of what a green run proves — the
loop and its seams, not durability and not a real catalog.

| Case                                   | Behaviour under evaluation                                                                                             |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `structured-output-decode`             | A well-formed answer decodes into the action's declared output schema in one model call.                               |
| `structured-output-from-prose`         | An answer wrapped in prose is extracted and decoded without spending a correction.                                     |
| `correction-reprompt-recovers`         | One malformed answer spends one correction slot; the re-prompted run decodes and the step succeeds.                    |
| `correction-budget-exhausted`          | A model that never produces the declared shape fails `/harness/StructuredOutputFailure`, not silently.                 |
| `cell-calls-a-flow`                    | A cell reaches a host capability through `ctx.call`, and the flow's typed result reaches the answer.                   |
| `read-only-cap-stops-a-reading-run`    | A task run that only reads is told to write or justify at its cap, and stops as `/harness/HarnessError` at twice it.   |
| `max-frames-stops-the-run`             | A run that never completes stops at its frame budget and reports `/harness/HarnessError`.                              |
| `seat-unresolved-is-typed`             | A host with no model for the declared seat refuses before any model call, as `@smthrs/agent/Seat/SeatUnresolved`.      |

Seven cases drive the agent through `AgentAction` — one typed step inside an
ordinary flow, which is how a workflow author reaches it. The read-only-cap case
drives the `Agent` service directly inside a real flow execution, because
`readOnlyCap` is an `Agent.Options` field that `AgentAction` does not forward.

Each case reduces its run to one `Observation`:

```ts
{ kind: "answer" | "failure", value?, failure?, modelCalls, flowCalls }
```

The case's `expected` is that observation written out in full, so a red case
names the behaviour that changed rather than a number that moved. Two scorers
grade every case, and they are independent: `behaviour` asks whether the run did
what the case declares, and `contract` asks whether the observation is well
formed at all — it decodes against the declared schema and then holds the
invariants the schema cannot state, namely that `kind` decides which of `value`
and `failure` is set and that `modelCalls` is a non-negative integer.

Cases are self-evidencing rather than count-based wherever the prompt makes that
possible. The correction case answers with valid JSON only when the prompt
carries the correction teaching, so a boundary that stopped re-prompting reports
the wrong answer and not merely a different call count. The read-only case
records `probe:demanded` only if the structural demand actually reached the
model.

## Files

| File            | What it is                                                                                                           |
| --------------- | -------------------------------------------------------------------------------------------------------------------- |
| `subject.ts`    | The composition under evaluation: the scripted provider, the seat seam, the host, and the two ways to run the agent. |
| `suite.ts`      | The ten scenarios, their declared expectations, the two scorers, and the case executor.                              |
| `run.ts`        | The entry point: runs the suite, compares it to the baseline, applies the gate, sets the exit code.                  |
| `baseline.json` | The committed baseline, in `@smthrs/evals` `Baseline` v1 form. Twenty records: ten cases times two scorers.          |
| `tsconfig.json` | Typechecks the suite: `npx tsc -p evals/agent`. Nothing else references it.                                          |

`baseline.json` is written by `Baseline.write`, which emits canonical
sorted-key single-line JSON. Do not reformat it: the file is regenerated, and a
pretty-printed copy only produces a diff the next `--update` reverses.

## Updating the baseline

```bash
bun evals/agent/run.ts --update
```

Do this only when a score moved for a reason you can name in the commit message.
The baseline is the record of what the agent used to do, and rewriting it is how
a behaviour change stops being visible.

Three mechanical facts about the baseline are worth knowing before you read a
red run:

- A scorer's identity is `Scorer.scorerKey`, a SHA-256 digest over its explicit
  stable id, version, and canonical configuration. Function source and runtime
  transpilation are deliberately absent, so Node and Bun reproduce the same
  baseline keys. Bump the scorer version when its scoring contract changes.
- A case's step key is fixed as `evals/agent:<case>`. The regression comparison
  reads a changed key as a new step and a changed score under an unchanged key as
  nondeterminism, so the key is stated rather than derived from a run.

## Adding a case

1. Add a scenario to the `scenarios` table in `suite.ts` with its `summary`, its
   `run`, and the `expected` observation written out in full. `cases` is derived
   from that table, so there is nothing else to keep in sync.
2. Prefer a scenario whose answer encodes the behaviour, not just its cost. A
   case that only counts model calls passes for the wrong reason as soon as an
   unrelated retry changes the count.
3. Run `bun evals/agent/run.ts --update`, read the recorded scores, and commit
   the baseline with the case.

## Limits

- **It scores a scripted provider.** Every case fixes what the model says, so
  the suite measures the loop around the model — decoding, correction, calls,
  budgets, discipline, seat resolution — and measures nothing about model
  quality.
  A live-provider suite is a separate thing and would not be deterministic.
- **One composition.** Every case runs with an empty registry, an empty
  capability envelope, and at most one host flow. Plugin ordering, memory
  injection, steering, compaction, and durable park-and-resume are covered by
  `packages/agent/test`, not here.
- **Failures are matched by tag, not by content.** A case that expects
  `/harness/HarnessError` would still pass if the harness raised that tag for a
  different reason. The tag is the stable half of the contract; the message is
  not.
