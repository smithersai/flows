# SWE-bench Verified benchmark rig

The benchmark that grades the flows built-in harness against the Codex CLI on
identical SWE-bench Verified instances, with the same model, on three
dimensions: **quality** (resolved rate), **speed** (wall clock), and **cost**
(tokens and USD).

This is an **operator-run** benchmark. It spends real API tokens, it needs
docker and multi-gigabyte official images, and one instance takes minutes to
tens of minutes. It is **not** part of any CI gate and must not become one: a
gate that needs a funded API key, a warm docker cache, and a nondeterministic
model cannot hold a tree, and a red it produces would say nothing about the
commit under test. The only thing here that is safe to run unattended is
`./verify.sh`, which checks the scorecard generator offline.

The rig lives in the repository so it cannot be lost again. It previously lived
in a session scratchpad, which was wiped, taking the dataset, the sample, the
CLI wrapper, and the evaluator environment with it.

## Layout

| Path                       | What it is                                                          |
| -------------------------- | ------------------------------------------------------------------- |
| `bootstrap.sh`             | Provisions everything transient: venv, dataset, sample, docker check |
| `flows.sh`                 | Runs this checkout's flows CLI in an arbitrary workspace             |
| `run-instance.sh`          | One instance through the flows harness                               |
| `run-instance-codex.sh`    | One instance through the Codex CLI, same conditions                  |
| `run-sample.sh`            | The sample, in draw order, one harness                               |
| `evaluate.sh`              | Grades collected patches with the official evaluator                 |
| `regen-patch.sh`           | Re-derives one patch from a surviving workspace                      |
| `scorecard.ts`             | Quality + speed + cost, per instance and in aggregate                |
| `prices.ts`                | The committed USD price table, with its sources                      |
| `verify.sh`                | Offline check that the scorecard still computes what it claims       |
| `baseline/`                | The committed codex numbers and patches to compare against           |
| `fixtures/`                | The recorded numbers `verify.sh` replays                             |
| `lib/`                     | Sampler, prompt writers, prediction builder, patch cleaner           |

Everything else the rig writes — `swb-verified.json`, `sample.json`,
`.venv-swb/`, `work/`, `patches/`, `timings/`, `logs-*/`, `preds-*.json`, the
evaluator's reports, `scorecard.*` — is transient and gitignored.

## Bootstrap

```sh
cd evals/swebench
./bootstrap.sh          # sample size 8 by default
```

It creates `.venv-swb` with the official `swebench` package, downloads
`princeton-nlp/SWE-bench_Verified` to `swb-verified.json` (500 instances),
regenerates `sample.json`, and reports whether docker is running and which
images the sample needs. It pulls no images; the run scripts pull the one image
they need, on demand. Nothing in bootstrap spends model tokens.

## Run one instance

```sh
export OPENAI_API_KEY=sk-...
./run-instance.sh django__django-16612 openai:gpt-5.6-sol 1200
```

The script extracts the instance's testbed out of the official image, bind
mounts it back at `/testbed` so the container's interpreter sees the same tree
the agent edits, writes the fix flow with `lib/write-flow.mjs`, drives the CLI
through `plan` → `approve` → `run` under a timeout, then diffs the working tree
against the instance's base commit with the harness scaffolding excluded and
strips mode-only churn. It leaves `work/<id>/` (including the run's journal in
`work/<id>/.flows/`), `patches/<id>.patch`, `timings/<id>.json`, and
`logs-agent/<id>.run.log`.

The codex baseline runs the same shape with its own isolated `CODEX_HOME`, the
same prompt content, and the same budget:

```sh
./run-instance-codex.sh django__django-16612 1500
```

The whole sample, one harness at a time:

```sh
./run-sample.sh flows 5
./run-sample.sh codex 5
```

## Wave arming gate

Before spending tokens on the rest of a wave, run and grade its first flows
instance, then inspect that workspace's journal for exactly one
`control.agent.discipline-armed` event per run. Its payload is the positive
record of the discipline configured at run start: `readOnlyCap` must be nonzero,
and `maxFrames` plus every armed sandbox limit (`calls`, `memoryBytes`, `steps`,
`timeMs`, `callMs`, and `totalMs`) must match the wave's intended budgets. Stop
the wave if the event is absent or the values are wrong.

Gate on this event rather than on `control.agent.read-only-demanded`. The demand
event proves an armed cap was reached, not merely armed; a run that writes early
and often correctly has no such event.

For the wave report, read `control.agent.read-only-demanded` directly. Each
event records the streak and configured cap that triggered the intervention,
the following frame number, and whether that frame wrote, justified continued
diagnosis, stayed read-only, or parked. Count these events rather than
reconstructing the intervention from transitions and call ordering.

## Evaluate

Grading is the unmodified official harness, never our own judgement of a patch:

```sh
./evaluate.sh r1 astropy__astropy-8707 django__django-16612 pydata__xarray-7393
HARNESS=codex ./evaluate.sh r1-codex astropy__astropy-8707
```

It writes `preds-<run-id>.json` and the evaluator's own
`<model-name>.<run-id>.json` report into this directory.

## Score

```sh
node scorecard.ts --report flows-cell-harness.<wave>.json
```

It reads every `flows-cell-harness.*.json` report in this directory, the
journals under `work/`, the stamps under `timings/`, and the patches under
`patches/`. Flags override each of those (`--work`, `--patches`, `--timings`,
`--reports`, `--model`, `--baseline`, `--instances`, `--out`).

`scorecard.json` and `scorecard.md` grade every instance on all three
dimensions and against the committed codex baseline:

- **quality** — the verdict from the evaluator's report (`resolved`,
  `unresolved`, `empty patch`, `eval error`), patch size, and whether the run
  ever landed an edit;
- **speed** — wall clock from `timings/<id>.json`, the journal's own span,
  turns, model calls, and per-call latency when the journal carries it;
- **cost** — input, cached and output tokens, and USD from `prices.ts`.

The flows-side numbers come from the run's journal through
`Forensics.digest` — the same projection `flows status` renders — so the
scorecard and the CLI cannot disagree about what a run did.

Two caveats the output states for itself:

- **Per-call latency** is reported as unavailable until the journaled
  `model-settled` event carries a duration. The scorecard reads any of the
  plausible field names and never requires one, so it works before and after
  that lands.
- **The codex USD figure is a floor.** The committed baseline records one total
  token count per instance, with no input/output split, so it is priced
  entirely at the input rate. Real codex cost is higher.

## The seeded sample

`sample.json` is regenerated, not committed, and the procedure is pinned:
mulberry32 seeded with **20260818**, a standard backward Fisher-Yates shuffle
over the dataset in dataset order, then the first _n_ rows. The dataset ships
sorted by `instance_id`, so the draw does not depend on which order a caller
believes it is using.

The first five draws are the drive's regression suite:

1. `astropy__astropy-8707`
2. `django__django-16612`
3. `pydata__xarray-7393`
4. `pytest-dev__pytest-6197`
5. `sphinx-doc__sphinx-11445`

Draws 6 through 8 are `pydata__xarray-7233`, `matplotlib__matplotlib-20826`,
and `astropy__astropy-14365`.

`lib/sample.mjs` asserts the five, and `bootstrap.sh` fails if the assertion
fails. **If that assertion ever fails, stop.** It means the dataset revision or
the procedure changed under the drive, and every committed baseline number is
about different instances. Find out which changed; do not benchmark against a
different sample and do not edit the pinned list to match a new draw.

## Standing rules of the drive

- **The current sample's failing instances are the regression suite.** They stay
  the target until all of them pass. A wave that improves an already-passing
  instance and leaves the failures untouched has not moved the drive.
- **Grow the sample slowly.** Add instances only when the current set is
  understood, and take them in draw order from `sample.json` so the set is
  always a prefix of the same seeded sequence.
- **Always run codex on the same instances.** A flows number without a codex
  number on the same instance, same model, same budget, and same container is
  not a comparison. Add the codex result to `baseline/codex-comparison.json`
  when the sample grows.
- **Both-fail instances are acceptable.** Some instances have hidden tests that
  reject the obvious fix. Recording `both fail` is a result, not a gap to close.
- **Any flows win gets called out explicitly.** The scorecard labels each
  instance `FLOWS WIN`, `codex win`, `both pass`, or `both fail`, and counts
  wins in the aggregate line. Say so in the write-up when the count moves.
- **Grading is the official evaluator.** Never grade a patch by reading it.

## The committed baseline

`baseline/codex-comparison.json` and `baseline/patches-codex/` are the Codex CLI
results from the 2026-08-18 wave: `gpt-5.6-sol`, reasoning effort medium, the
same extracted checkouts and containers, graded by the official evaluator. Codex
resolved 4 of 5. The flows numbers recorded beside them are from the wave that
scored 1 of 5; the drive's best recorded wave scored 2 of 5 (2026-08-19). Flows
wins in both: 0. Those are the numbers to beat.

`fixtures/mirror-results.json` is what the flows side measured on that wave. The
journals themselves did not survive the scratchpad wipe, so `verify.sh` rebuilds
a journal carrying exactly those numbers and asserts the scorecard reports them:

```sh
./verify.sh
```

That is an offline check of the tooling — no tokens, no docker, no dataset. Run
it after touching `scorecard.ts`, `prices.ts`, or the journal's event shapes.

## `flows.sh`

The run scripts drive the CLI from an extracted testbed, which is an arbitrary
directory outside this repository. `flows.sh` resolves
`packages/cli/dist/esm/bin.js` out of the checkout and execs it in place, so the
CLI reads its project flows from the workspace (`flows/fix/flow.mdx`) and keeps
its control database in the workspace's `.flows/`. The entry point is a build
artifact and gitignored, so the wrapper builds `@smthrs/cli` when it is missing;
set `FLOWS_CLI_REBUILD=1` to rebuild it after editing CLI sources.

Checked without spending tokens: `plan` renders the approval payload, `approve`
accepts it, and `run` reaches the model boundary and refuses with
`LaunchFailed: Set OPENAI_API_KEY to run the openai:gpt-5.6-sol seat` when no
key is exported. Everything past that boundary needs a funded key and is what
`run-instance.sh` exercises.
