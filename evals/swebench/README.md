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
| `preflight.sh`             | Builds the subject, fingerprints it, and pins it for the wave        |
| `flows.sh`                 | Runs this checkout's flows CLI in an arbitrary workspace             |
| `readonly-liveness.sh`     | Proves the read-only control fires through the real CLI (spends ~$0.30) |
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
| `lib/`                     | Sampler, prompt writers, prediction builder, patch capture, subject fingerprint |

Everything else the rig writes — `swb-verified.json`, `sample.json`,
`.venv-swb/`, `.subject.json`, `work/`, `work-liveness/`, `patches/`,
`timings/`, `logs-*/`, `preds-*.json`, the evaluator's reports, `scorecard.*` —
is transient and gitignored.

## The subject under test

**A wave measures the working tree, not a commit.** Every `@smthrs/*` package's
workspace `exports` map points at `./src/*.ts`, so
`packages/cli/dist/esm/bin.js` resolves `@smthrs/harness/CellTurn` to
`packages/harness/src/CellTurn.ts` and Node strips its types on load. The
harness under test is therefore whatever is on disk at the instant each CLI
process starts. `packages/harness/dist` is not in the loaded graph at all and
its state means nothing. `packages/cli` is the one package whose build is
loaded, through the `bin.js` entry point.

Two consequences, both of which have already cost a wave:

- A sibling lane editing `packages/harness/src` while a wave is in flight
  changes the subject between instances, with nothing in the artifacts saying
  so.
- Building a filter closure — `pnpm --filter "@smthrs/cli..." build --no-bail` —
  builds packages nothing loads and, with `--no-bail`, reports success while a
  package in the middle failed.

So the wave pins its subject first:

```sh
./preflight.sh
```

It builds exactly one package (`@smthrs/cli`, no closure, no `--no-bail`, a
non-zero exit is fatal), derives a content fingerprint with `lib/subject.mjs`,
and writes `.subject.json`. The fingerprint records, for every package in the
CLI's `@smthrs/*` dependency closure, where its entry point resolves and a
content hash of the directory that answer selects — plus the hash of
`packages/harness/src/CellTurn.ts` as the marker a report cites, the hash of
`packages/cli/dist/esm`, the git HEAD, and the node version.

`preflight.sh` refuses to pin a subject that cannot be reported honestly:

| Refusal | What it catches |
| --- | --- |
| `no-cli-build` | `packages/cli/dist/esm/bin.js` does not exist |
| `partial-cli-build` | a `src/X.ts` has no `dist/esm/X.js` — a build that stopped early |
| `unresolvable` | a package cannot resolve a dependency the way the process will |
| `foreign-subject` | a package resolves outside this checkout |
| `unbuilt-dist` | a dependency resolves into a `dist/` this rig does not build |
| `dirty-subject` | a package's `src` differs from `git HEAD`, so no report may name a commit |

`SWB_ALLOW_DIRTY_SUBJECT=1` runs a wave on an uncommitted subject anyway. The
fingerprint still records every differing path, and the scorecard prints them,
so the report cannot claim a clean commit.

After the pin, **every `flows.sh` invocation re-derives the fingerprint and
refuses to run when it has moved** (exit 4). A wave that starts on one harness
and finishes on another stops instead of being averaged into one number.
`SWB_SUBJECT_UNPINNED=1` skips the check for one-off CLI calls by hand; never
use it for a wave.

`run-instance.sh` stamps the pinned fingerprint into `timings/<id>.json`, and
`scorecard.ts` prints the wave's preconditions from those stamps — including an
`agreement` line that says outright when two instances ran different subjects.

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
./preflight.sh                                                   # once per wave
./run-instance.sh django__django-16612 openai:gpt-5.6-sol 1200
```

The script extracts the instance's testbed out of the official image, bind
mounts it back at `/testbed` so the container's interpreter sees the same tree
the agent edits, records the capture base (below), writes the fix flow with
`lib/write-flow.mjs`, drives the CLI through `plan` → `approve` → `run` under a
timeout, then captures the patch. It leaves `work/<id>/` (including the run's
journal in `work/<id>/.flows/`), `patches/<id>.patch`,
`patches/<id>.patch.untracked`, `timings/<id>.json`, and
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

## Patch capture

**The captured patch holds what the agent changed and nothing else.** Both run
scripts record a *capture base* right after extracting the testbed and before
anything of ours touches it (`lib/snapshot-base.sh`, kept in the workspace as
`refs/flows/capture-base`), and capture the patch against that
(`lib/capture-patch.sh`), never against the instance's base commit. Two
contaminants are excluded at the source rather than edited out afterwards:

- **What the official image already changed.** The images mutate tracked files
  in their `pre_install` step — `sphinx-doc__sphinx-11445` seds `-rA` into
  `tox.ini`. Diffed against the base commit that churn is reported as the
  agent's work, and it does not merely inflate the patch: the evaluator's
  container already carries it, so `git apply` fails on the whole patch and the
  `patch --fuzz=5` fallback reads the already-applied hunks as a reversal and
  **un-applies the real fix**. That defect decided the sphinx verdict in waves 2,
  3 and 4, on both harnesses. The capture base contains the churn, so it cancels.
- **Files that did not exist when the agent started.** The flows durability
  snapshot writes the whole working tree into git's index, so agent scratch is
  tracked by capture time; wave 3 shipped `.tmp_init_collect_repro/` with an
  `assert False` in it. Capture restores the index to the capture base, which
  drops them — and that is the same set the codex path never had in its index,
  so both harnesses are captured under one rule. Whatever is dropped is listed
  in `patches/<id>.patch.untracked`; read it when a run was supposed to add a
  file.

Normalising the modes falls out of the same restore: the patch is expressed in
the image's own permission bits, so the executable-bit churn that `docker cp` to
the host and the colocated jj snapshot introduce never appears.

Two ways to check it, neither of which spends a token:

```sh
./verify.sh                                              # offline, no docker
SWB_SKIP_AGENT=1 ./run-instance.sh sphinx-doc__sphinx-11445   # docker, no agent
```

`verify.sh` replays both contaminants over throwaway git repositories shaped
like the official images (`fixtures/check-capture.mjs`). `SWB_SKIP_AGENT=1`
builds the real workspace, runs no agent, and captures: **the patch must be
empty.** It rebuilds `work/<id>/`, so do not point it at a workspace whose
journal is still wanted, and it writes no timings stamp because no run happened.

`regen-patch.sh <id>` re-captures from a surviving workspace. It refuses a
workspace with no capture base instead of falling back to the base commit.

**Deliberately not changed: what the agent is told.** `lib/write-flow.mjs` still
tells the agent to review its own work with `git diff <base commit>`, so on an
image with `pre_install` churn the agent sees a file it did not touch. Pointing
it at `refs/flows/capture-base` would be more honest and would remove any
incentive to "clean up" that file — but it is prompt text, and changing prompt
text mid-drive confounds the wave-to-wave comparison the drive exists to make.
Decide it as a wave change, not as a side effect of a capture fix.

## Wave arming gate

The gate has two halves: the subject the wave loads, and the discipline that
subject arms. Pin the subject with `./preflight.sh` (above) before anything
else; a wave that cannot say which harness it ran cannot report an arming
either.

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

**Zero demand events is not evidence that the cap is dead.** Read them together
with `control.agent.transition-applied`. A transition that carries a
`justification` on the frame where the streak reaches the cap satisfies the
demand before it is issued: `CellTurn` suppresses the pending demand, grants
`readOnlyCap` quiet frames, and journals nothing. Wave 6's
`pytest-dev__pytest-6197` is the recorded case — an earned twelve-frame streak,
`readOnlyCap: 12` armed, no demand event, and frame 11's transition carrying an
unsolicited justification. The cell contract asks for a justification only when
the harness has asked for one; the model volunteers them anyway, on roughly a
third of frames. So a wave report that finds no demand events must state which
of the two it observed:

- no run reached the cap (read the longest no-mutation streak from
  `control.agent.mutation-observed`), or
- a run reached it and a justification pre-empted the demand.

To tell a live control apart from a dead one without waiting for a wave:

```sh
./readonly-liveness.sh                 # ~$0.30 in tokens, no docker, no dataset
```

It builds a throwaway workspace whose flow reads one file per frame, forbids
`justification`, and stops on the demand text, then asserts the journal contains
`control.agent.read-only-demanded` and prints the streak, the cap, the
justification count and the run's own cost. Run it after any change to
`CellTurn`, to the CLI composition, or to the seat resolver. Recorded result on
`aefd3b39d`, `CellTurn.ts sha256:a834c2fd…`: **one demand event**, `streak=12
cap=12 nextFrame=12 nextAction=read-only`, 13 frames, 0 justifications, 57,067
input and 1,319 output tokens, $0.3249.

## Evaluate

Grading is the unmodified official harness, never our own judgement of a patch:

```sh
./evaluate.sh r1 astropy__astropy-8707 django__django-16612 pydata__xarray-7393
HARNESS=codex ./evaluate.sh r1-codex astropy__astropy-8707
```

It writes `preds-<run-id>.json` and the evaluator's own
`<model-name>.<run-id>.json` report into this directory.

`SWB_EVAL_WORKERS` sets the evaluator's concurrency (default 1; raising it loses
the report — see the script). `SWB_CACHE_LEVEL` sets `--cache_level` (default
`env`, which deletes each official instance image once it is graded); use
`instance` for a supplementary grading that should leave the image cache as it
found it.

## Score

```sh
node scorecard.ts --report flows-cell-harness.<wave>.json
```

It reads every `flows-cell-harness.*.json` report in this directory, the
journals under `work/`, the stamps under `timings/`, and the patches under
`patches/`. Flags override each of those (`--work`, `--patches`, `--timings`,
`--reports`, `--model`, `--baseline`, `--instances`, `--out`).

`scorecard.json` and `scorecard.md` open with the wave's **preconditions** —
the subject stamp, the git HEAD, the `CellTurn.ts` hash, the path it was loaded
from, the `packages/cli/dist/esm` hash, the node version, any refusal the
preflight recorded, and an `agreement` line stating whether every instance ran
the same pinned subject. Copy that block into the wave report; do not retype it.
An `agreement` line reading `MISMATCH` means the wave is two measurements and
must not be reported as one.

They then grade every instance on all three dimensions and against the committed
codex baseline:

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
- **One wave, one subject.** Pin with `./preflight.sh` before the first
  instance, and do not edit any package the CLI loads until the last one
  finishes. `flows.sh` enforces this and stops the wave when the subject moves;
  a wave that has to be restarted is cheaper than a wave whose report names a
  commit half of it did not run.
- **Grading is the official evaluator.** Never grade a patch by reading it.
- **Never correct a patch by hand.** If a captured patch holds something the
  agent did not write, that is a capture defect: fix `lib/capture-patch.sh` or
  `lib/snapshot-base.sh` and re-derive with `regen-patch.sh`. A patch edited
  after the fact grades a different artifact from the one the run produced, and
  it cannot be reproduced by the next wave.

  One recorded exception exists, and it is the reason the rule is written down.
  A **codex** run deletes its workspace when it finishes (`run-instance-codex.sh`
  ends in `rm -rf "$WORK"`), so a codex patch cannot be re-derived at all once
  the run is over. The 2026-08-20 sphinx correction therefore removed the whole
  contaminated `tox.ini` file section from the recorded capture rather than
  re-capturing, and the corrected patch still carries the pre-fix
  `old mode`/`new mode` lines that `lib/capture-patch.sh` no longer emits. That
  is admissible only under all three of these conditions, each of which that
  correction meets: whole file sections are dropped and no line is rewritten,
  the untouched capture is committed beside it, and the official evaluator
  re-grades the result. A future codex baseline should be re-run instead —
  keeping its workspace is the real fix, and it is not done here.

## The committed baseline

`baseline/codex-comparison.json` and `baseline/patches-codex/` are the Codex CLI
results from the 2026-08-18 wave: `gpt-5.6-sol`, reasoning effort medium, the
same extracted checkouts and containers, graded by the official evaluator.
**Codex resolved 5 of 5.**

It was recorded as 4 of 5 until 2026-08-20. The `sphinx-doc__sphinx-11445`
verdict was decided by the patch-capture defect above, not by codex's patch:
captured against the base commit it carried the image's `tox.ini` churn, which
reverse-applied at grading. The agent-only content resolves. The committed
baseline patch is the recorded capture with that whole `tox.ini` file section
removed — not a re-capture, because a codex run deletes its workspace and there
is nothing left to re-capture from — so it still carries the pre-fix
`old mode`/`new mode` lines. See the hand-correction rule above for the
conditions that makes admissible. The evidence is in `baseline/evidence/` — the
evaluator's own report on exactly the committed patch, its summary, and the raw
contaminated capture the old rule produced, which is that patch plus the removed
section. **Sphinx is not a flows win.** Flows matched it in wave 4,
under the same correction, so the instance is both-pass; the only win on this
sample belongs to codex, on `pytest-dev__pytest-6197`.

The flows numbers recorded beside the baseline are from the wave that scored
1 of 5; the best recorded wave scored 4 of 5 (wave 4, 2026-08-20). Flows wins:
0. Those are the numbers to beat.

`fixtures/mirror-results.json` is what the flows side measured on that wave. The
journals themselves did not survive the scratchpad wipe, so `verify.sh` rebuilds
a journal carrying exactly those numbers and asserts the scorecard reports them:

```sh
./verify.sh
```

That is an offline check of the tooling — no tokens, no docker, no dataset. It
also replays the repository-specific verification guidance, the patch capture
(`fixtures/check-capture.mjs`), and the subject fingerprint
(`fixtures/check-subject.mjs`, which needs a built CLI: run `./preflight.sh`
first if `packages/cli/dist` is absent). Run it after touching `scorecard.ts`,
`prices.ts`, the journal's event shapes, or anything under `lib/`.

## `flows.sh`

The run scripts drive the CLI from an extracted testbed, which is an arbitrary
directory outside this repository. `flows.sh` resolves
`packages/cli/dist/esm/bin.js` out of the checkout and execs it in place, so the
CLI reads its project flows from the workspace (`flows/fix/flow.mdx`) and keeps
its control database in the workspace's `.flows/`.

The wrapper does not build. `./preflight.sh` builds and pins, once per wave, and
`flows.sh` checks itself against that pin on every invocation (see [The subject
under test](#the-subject-under-test)). The old rule was "build only when
`bin.js` is missing", which after the first wave is never — and since the CLI's
dependencies are loaded from the working tree, no rebuild rule could have
pinned them anyway.

Checked without spending tokens: `plan` renders the approval payload, `approve`
accepts it, and `run` reaches the model boundary and refuses with
`LaunchFailed: Set OPENAI_API_KEY to run the openai:gpt-5.6-sol seat` when no
key is exported. Everything past that boundary needs a funded key and is what
`run-instance.sh` exercises.
