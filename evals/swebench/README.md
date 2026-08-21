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
| `run-matrix.sh`            | The sample n times over, one harness, at a bounded concurrency       |
| `select-candidate.mjs`     | Picks one instance's submission out of its n runs, from journals alone |
| `evaluate.sh`              | Grades collected patches with the official evaluator                 |
| `grade-matrix.sh`          | Grades a matrix in three groups: flows rounds, codex rounds, selected |
| `matrix-report.mjs`        | Reliability, best-of-n, selector quality, single-attempt continuity  |
| `regen-patch.sh`           | Re-derives one patch from a surviving workspace                      |
| `scorecard.ts`             | Quality + speed + cost, per instance and in aggregate                |
| `prices.ts`                | The committed USD price table, with its sources                      |
| `verify.sh`                | Offline check that the rig still computes what it claims             |
| `baseline/`                | The committed codex numbers and patches to compare against           |
| `fixtures/`                | The recorded numbers `verify.sh` replays                             |
| `lib/`                     | Sampler, prompt writers, prediction builder, patch capture, subject fingerprint, per-run naming, journal reader |

Everything else the rig writes — `swb-verified.json`, `sample.json`,
`.venv-swb/`, `.subject.json`, `work/`, `work-liveness/`, `patches/`,
`timings/`, `logs-*/`, `journals/`, `selected/`, `matrix-*.json`,
`preds-*.json`, the evaluator's reports, `scorecard.*` — is transient and
gitignored.

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
`packages/harness/src/CellTurn.ts` as the marker a report cites, the hashes of
`packages/cli/dist/esm` and `packages/cli/src`, the git HEAD, and the node
version.

`packages/cli/src` is in the stamp even though no process loads it. It is the
only package where what is on disk and what runs are two different things, so
it is the only one whose build can go stale under a wave: an edit to any other
package changes bytes the CLI loads and stops the wave at the next `flows.sh`
call, while an edit to the CLI's own source used to change nothing the pin could
see. Hashing both means a pinned pair asserts that one `preflight.sh` run
produced them together, and a CLI source change stops the wave until another one
does. What no fingerprint can see is a complete `dist/esm` compiled from source
that is no longer on disk; `preflight.sh` deletes `dist` before it builds, so a
pinned pair only ever comes from a full rebuild.

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
journal in `work/<id>/.flows/`), `journals/<id>/` (that journal, copied out
so it survives the next wave), `patches/<id>.patch`,
`patches/<id>.patch.untracked`, `timings/<id>.json`, and
`logs-agent/<id>.run.log`.

The codex baseline runs the same shape with its own isolated `CODEX_HOME`, the
same prompt content — including the repository's own test runner, which
`lib/test-command.py` derives for both sides — and the same budget:

```sh
./run-instance-codex.sh django__django-16612 1500
```

The whole sample, one harness at a time:

```sh
./run-sample.sh flows 5
./run-sample.sh codex 5
```

Both run scripts take an optional trailing **run index**, which is how one
instance carries five attempts at once. See [Best-of-n](#best-of-n).

## The prompts

`lib/write-flow.mjs` writes the flows prompt and `lib/write-prompt-codex.mjs`
writes the codex one. **They differ only where they name a harness's own tools.**
Anything else one side is told and the other is not is a variable the comparison
does not control, and it shows up in the score as if it were harness quality.

The flows-only lines are the frontmatter, the `write`/`read` flows, and the
Jujutsu colocation the flows CLI creates in its own workspace and the codex
workspace never has. `fixtures/check-prompts.mjs`, in `verify.sh`, lists them and
asserts that the set of lines one prompt has and the other does not is exactly
that list — so a sixth line, or a shared line dropped from one side, fails
offline instead of moving a baseline quietly. It also asserts that neither prompt
names `FAIL_TO_PASS`, `PASS_TO_PASS`, the graded test identifiers, or the gold
patch, with all of them present in the synthesised instance row both writers are
handed.

**The repository's test command goes to both sides.** It comes from the pinned
evaluator's `MAP_REPO_VERSION_TO_SPECS` through `lib/test-command.py`, which
refuses to print a command naming the graded identifiers, and it is environment
teaching of the same kind as "run it in the container": `./tests/runtests.py`
for Django, `tox` for Sphinx, `pytest -rA` elsewhere.

> **Disclosure — codex baselines before 2026-08-21.** From 2026-08-19 the flows
> prompt named that runner and the codex prompt still told its agent to verify
> with `python -m pytest`, which neither Django nor Sphinx can run. Waves 10 and
> 11 therefore compared a harness that could check its work against a baseline
> that could not, on two of the five sample instances, and the rig said nothing.
> Codex numbers for `django__django-16612` and `sphinx-doc__sphinx-11445` from
> those waves are not comparable and a write-up that quotes them owes this
> sentence. Both sides derive the command from `lib/test-command.py` now, and the
> next codex wave is the first one the head-to-head number holds for.

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
and `maxFrames`, `modelCallMs`, `repeatCap`, `narrowingCap`, `unmovedCap`,
`unresolvedCap`, plus every armed
sandbox limit (`calls`, `memoryBytes`, `steps`, `timeMs`, `callMs`, and
`totalMs`) must match the wave's intended budgets. Stop the wave if the event is
absent or the values are wrong.

Gate on this event rather than on `control.agent.read-only-demanded`. The demand
event proves an armed cap was reached, not merely armed; a run that writes early
and often correctly has no such event.

`modelCallMs` is the one armed budget a report can grade without any further
instrumentation, because `control.agent.model-settled` already carries
`durationMillis` for every call. Read the two together: no settled call may
exceed the armed ceiling, and a call that reached it appears as a
`control.agent.model-retried` event coded `call_timeout` followed by a second
attempt. Wave 7 is the reason the budget exists — one 667,067 ms call on
`pytest-dev__pytest-6197` spent 55% of that run's wall clock and produced a cell
that raised on its first property access — so a wave whose longest
`durationMillis` sits near the ceiling is reporting a real finding, not noise.
One overrun costs at most one re-issue, so the most model time a single sealed
step can spend is twice `modelCallMs`; a report that adds up more than that on
one step is reading a bug, not a budget.

`repeatCap` is armed the same way and read from
`control.agent.repeat-demanded`, which is journaled when the demand is *issued*
rather than when it is answered. Zero demand events with a nonzero `repeatCap`
is a wave whose runs never spent four consecutive frames re-asking questions
they had already answered, which is the intended reading; zero with `repeatCap:
0` says the control was never armed at all.

`narrowingCap` is armed the same way and read from
`control.agent.narrowed-demanded`, also journaled when the demand is issued. It
is the one control that acts on a completion rather than on a stall, so it fires
at most once per run and usually not at all: a wave with zero demand events and
a nonzero `narrowingCap` is a wave whose runs each re-ran their broad check over
the tree they submitted, and zero with `narrowingCap: 0` says nothing was ever
asked. Each event carries both inputs and both workspace digests, so a report
can second-guess the demand from the journal without replaying the run.

`unmovedCap` and `unresolvedCap` are the other two controls that act on a
completion, armed the same way and read from `control.agent.unmoved-demanded`
and `control.agent.unresolved-demanded`. Both are journaled when the demand is
issued and both fire at most once per run.

`unmoved-demanded` carries the digest the run opened on and the digest its
completing frame closed on, which are equal by construction; reconcile them
against the run's own `control.agent.mutation-observed` events, which say the
same thing frame by frame. Wave 9's `django__django-16612` is the recorded case:
seven frames, eleven calls, no editing call of any kind, one digest throughout,
a zero-byte patch, and a completion describing an edit.

`unresolved-demanded` carries the failing check and the reading the run took in
its place, both over the digest the frame closed on. It is not a rule about
failing checks: wave 9's `astropy__astropy-8707` **resolved** after a post-edit
broad check reported two failures, because it never went back to what that check
covered. The demand fires only where the run itself returned to the same
subject with a different command, which is wave 9's `pytest-dev__pytest-6197` —
`pytest -rA testing/python/collect.py` at seq 394 reporting "2 failed, 72
passed", then four named cases out of that file at seq 429 reporting "4 passed",
then `complete`.

When one completing frame trips more than one of the three, only the first is
issued, in the order `unmoved`, `unresolved`, `narrowed`: descending order of
how fundamental the missing thing is. A journal therefore never carries two
completion demands at one `transition-applied`, and never carries one at the
frame a demand was handed to: every demand ends by promising that what comes
back next is the answer that stands, so the frame written to answer one is not
judged again. A run bounced once and then bounced again for a different reason
would spend two frames and two model calls arguing about one decision, and the
second demand is dropped rather than issued.

A demand is also not issued when the read-only cap holds the frame it would
reserve. The two controls meet on the same runs — a run whose tree never moved
has a read-only streak as long as its life — and a completion one frame short of
twice `readOnlyCap` would be bounced, spend that frame reading, and end as a
`read_only_cap` failure carrying nothing. So a wave that arms a low
`readOnlyCap` will see fewer `unmoved-demanded` events than its runs' digests
suggest, and none of them are missing: the demand is a frame the run has to
have.

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

The probe spends tokens, so its verdict cannot be re-run to settle an argument;
the reading that turns a journal into that verdict can be.
`fixtures/check-liveness-report.mjs`, in `verify.sh`, replays
`lib/check-liveness.mjs` over synthesised journals and pins all four answers —
fired, INCONCLUSIVE below the cap, FAILED naming a justification, and FAILED
with nothing to blame — plus the streak arithmetic that a write clears.

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

Three overrides exist for the best-of-n matrix, where one instance has n patches
and the evaluator's predictions can only ever be keyed by instance id:
`SWB_PATCH_SUFFIX=-r3` grades `<id>-r3.patch` as `<id>`'s prediction,
`SWB_PATCHES=selected` grades a different directory, and `SWB_MODEL_NAME`
changes the name the report is filed under. `grade-matrix.sh` drives all three.

## Best-of-n

A single-attempt number says what a harness did once. It does not say whether it
would do it again, and waves 3 through 11 have shown the same instance resolving
in one wave and shipping an empty patch in the next. This is the protocol for
measuring the other thing: **n attempts per instance on both harnesses, and one
submission per instance chosen from the runs' own records.**

```sh
./preflight.sh                       # pin the subject, once
./run-matrix.sh flows 5 3            # 5 attempts of each instance, 3 at a time
./run-matrix.sh codex 5 3            # the same on the other side
./grade-matrix.sh w12 all 5          # select, then grade all three groups
node matrix-report.mjs --prefix w12  # the report
```

### Per-run artifacts

Every artifact name comes from `lib/run-paths.sh`, which both run scripts and the
matrix driver derive their names from, so the two harnesses cannot drift apart:

| | no run index | run index `r3` |
| --- | --- | --- |
| flows workspace | `work/<id>` | `work/<id>-r3` |
| flows patch | `patches/<id>.patch` | `patches/<id>-r3.patch` |
| flows timings | `timings/<id>.json` | `timings/<id>-r3.json` |
| flows logs | `logs-agent/<id>.*` | `logs-agent/<id>-r3.*` |
| flows container | `flowsbench-<id>` | `flowsbench-<id>-r3` |
| journal archive | `journals/<id>/` | `journals/<id>-r3/` |
| codex workspace | `work-codex/<id>` | `work-codex/<id>-r3` |
| codex patch | `patches-codex/<id>.patch` | `patches-codex/<id>-r3.patch` |
| codex timings | `timings-codex/<id>.json` | `timings-codex/<id>-r3.json` |
| codex logs | `logs-codex/<id>.*` | `logs-codex/<id>-r3.*` |
| codex container | `codexbench-<id>` | `codexbench-<id>-r3` |

**No index is today's names**, so `regen-patch.sh`, `scorecard.ts --work work`
and every wave report that quotes a path keep working. A run still *has* an
index — `r1` when none was given — because the matrix manifest and every log
line are keyed by `<id>-<index>` and a nameless run could be recorded in
neither.

The journal archive carries the **patch's** suffix rather than the run index, so
the journal and the patch a selection is made from always come from one run. Key
the archive by the index instead and a hand run, whose patch is `<id>.patch`,
overwrites the archive belonging to `<id>-r1.patch` — after which the selector
ranks a journal against a patch another run wrote and nothing says they came
apart.

`fixtures/check-run-paths.mjs`, in `verify.sh`, pins the whole table, proves five
rounds name five distinct sets on both sides, and proves the run scripts derive
their names from that one file rather than spelling them again.

### Disk

Two things bound a matrix, and they are bounded by different numbers.

**The host disk holds workspaces, and `jobs` bounds it.** A flows run now
archives its journal to `journals/<id>-<index>/` right after the patch is
captured — `engine.db` and its write-ahead log — and then, if it was given a run
index, deletes the extracted testbed. Everything downstream reads the archive:
the selector, and any later forensics. A run *without* an index keeps its
workspace, because `regen-patch.sh` re-derives a patch from it and the
scorecard's default `--work work` reads its journal in place;
`SWB_KEEP_WORKSPACE=1` keeps a matrix run's workspace for debugging and
`SWB_DELETE_WORKSPACE=1` deletes an unindexed one. A codex run already deleted
its workspace, so nothing changed there.

Measured on the current five-instance sample, post-run, on this machine:

| instance | workspace | of which `.git` | journal |
| --- | --- | --- | --- |
| `astropy__astropy-8707` | 127 MB | 40 MB | 6.4 MB |
| `django__django-16612` | 162 MB | 96 MB | 1.2 MB |
| `pydata__xarray-7393` | 33 MB | 14 MB | 7.4 MB |
| `pytest-dev__pytest-6197` | 25 MB | 15 MB | 3.4 MB |
| `sphinx-doc__sphinx-11445` | 72 MB | 44 MB | 2.4 MB |

So a 25-run flows matrix at `jobs=3` peaks at three live workspaces — **at most
3 × 162 MB ≈ 0.5 GB** — plus 25 archived journals at up to 7.4 MB each, about
0.2 GB, plus patches in kilobytes. Under 1 GB, and flat in the number of rounds.
Keeping all 25 workspaces instead would be 5 × 419 MB ≈ 2.1 GB and would grow
linearly with the round count and with the sample.

**The docker VM holds images, and the sample size bounds it — not `jobs`.** The
matrix is round-major, so every instance's image is used in every round and all
of them stay warm for the whole matrix whatever the concurrency is. Measured
with `docker system df -v`: the five official images report 2.68–4.67 GB each
and share a 1.4 GB base, for **12.0 GB resident** (10.5 GB unique + 1.5 GB
shared). Adding the workspace and journal peak above, a 25-run flows matrix on
this sample is about **12.7 GB resident, inside a 16 GiB budget** — and the term
that would have broken it is the one the deletion removes, because it is the only
term that grows with the round count. A container's own writable layer is
negligible: the testbed is bind-mounted from the host, not copied into the image.

The extraction itself stays serialized by `run-instance.sh`'s existing lock, so
the disk-bandwidth spike is one `docker cp` at a time however many runs are in
flight.

### The driver

```sh
./run-matrix.sh <flows|codex> <count-per-instance> <jobs> [timeout-seconds]
```

It schedules `count × instances` runs — the sample's first `SWB_SAMPLE_COUNT`
draws, 5 by default — and enforces two rules:

- **`jobs` runs in flight, no more**, the same bound `run-sample.sh` applies and
  for the same reason: concurrency buys overlap on the model-bound agent runs,
  not on the extraction.
- **Never two simultaneous runs of one instance.** They would share an image and
  an image cache, so the second would report a warm pull the first paid for; and
  each live run of an instance holds a testbed, so running an instance's five
  attempts back to back would put five of one repository's workspaces on disk at
  once. The schedule is round-major — every instance's r1, then every
  instance's r2 — and a run waits on its own instance's previous attempt.

It does not stop on a failing run: a timeout is a result the matrix is
measuring. Every run's exit status, patch size and wall clock lands in
`matrix-<harness>.json`, sorted by instance and round rather than by finishing
order.

`fixtures/check-matrix.mjs`, in `verify.sh`, replays the scheduler with
`SWB_RUN_CMD` pointing at a stub that records its own start and end. It asserts
from that ledger that the two rules held, that the driver did overlap runs at
all, and that the manifest it wrote agrees with what the runs actually did — no
docker, no model, no tokens.

It runs the scheduler twice, because one pass cannot check both rules. With three
instances and two jobs the concurrency bound already serializes an instance's
rounds, so deleting the same-instance wait leaves that schedule unchanged and the
pass green. The second pass is one instance and three jobs, where the only thing
that can keep two rounds apart is the rule itself, and the ledger has to read
`S r1 E r1 S r2 E r2 S r3 E r3`.

### The selector

```sh
node select-candidate.mjs <instance_id> [--journals dir] [--patches dir] [--out dir]
```

**The selector must never read evaluator output**, and its header says so. A
best-of-n number is only a number about the harness if the choice among the n
runs is made from what the harness itself recorded; a selector that peeked at the
official report — or at the dataset's `FAIL_TO_PASS` list — would be reporting an
oracle, and an oracle says nothing about whether a run can tell its own work is
finished.

The rule is enforced by what the program can name. It takes an instance id and
three **directories**, and every file it opens is derived from the id and a run
index: `journals/<id>-<rN>/engine.db` and `patches/<id>-<rN>.patch`. The
evaluator's reports are `<model-name>.<run-id>.json` at the rig root, and no
argument, flag or code path here can name one. An unrecognised flag is refused
rather than ignored.

It ranks candidates on four predicates, each read back off the journal through
the harness's own modules rather than re-implemented — `lib/journal-facts.mjs`
rebuilds the controller's per-frame state from the event stream and asks
`NarrowedCheck`, `Sufficiency`, `UnresolvedFailure` and `UnmovedTree` the same
questions `CellTurn` asks them:

1. **a check failed over the pre-edit tree** — a call reported a failing exit
   status in a frame at epoch 0, before the run had changed anything, in a frame
   that itself changed nothing (`NarrowedCheck.Check` `stable`, so the digest
   stamped on it is a tree the check really ran over);
2. **the tree moved after it** — a later frame's `mutation-observed` says the
   workspace changed;
3. **the same check, or a broader one, went green over the final tree** —
   `Sufficiency.find`'s own relation, restricted to frames whose closing digest
   is the digest the run finished on. "Broader" is `NarrowedCheck` `narrows`:
   every term of the passing check carried by the failing one;
4. **the completion holds** — the run applied a `complete` transition, and at
   that frame neither `UnmovedTree.find` nor `UnresolvedFailure.find` names a
   condition.

More predicates held wins. Ties break on the predicates in that order, then on a
**broader final check** (fewer terms), then a **non-empty patch**, then **lower
cost**, then the **lower run index** — the last key making the order total, so
the same journals always choose the same run.

It writes `selected/<id>.patch`, byte for byte the chosen run's patch, and
`selected/<id>.rationale.json`, which names the journal sequence number behind
every predicate of every candidate and the reason each unheld predicate did not
hold. The choice can be second-guessed from the journals without re-running
anything.

Three readings the journal cannot give, all stated in `lib/journal-facts.mjs`
rather than guessed silently: whether a call declared a write is per frame and
not per call, so a call is read as mutating when its flow is an editing flow;
the call signature is the canonical form of `[flow, input]` rather than the
controller's digest of it, which is the same equivalence relation; and
`sufficiency-observed` and `narrow-only-demanded` reach the journal through
`AgentSession`'s default branch, which writes the event's name and an empty
payload, so the selector counts them and recomputes anything it needs from the
frames instead of reading their fields.

`fixtures/check-selector.mjs` pins that too, because every case it runs is a
rehydrated distillation and a distillation proves the ranking, not the shape:
rename an event or a payload field in `packages/agent/src/AgentSession.ts` and
the fixture would stay green while every predicate silently read `false` on a
real run. It asserts that every event `lib/journal-facts.mjs` reads is one
`AgentEvent` declares, that the six it reads *fields* off are mapped by hand
rather than through the empty-payload default, and that those fields are still
the names `AgentSession` writes.

`fixtures/check-selector.mjs`, in `verify.sh`, replays the selector over two real
waves. Wave 10 and wave 11 ran the same five instances and both distillations
survive (`packages/harness/test/fixtures/wave10Journals.json` and
`fixtures/wave11-journals.json`), so `fixtures/rehydrate-journals.mjs` turns them
back into the databases the selector reads and the two-candidate case is two real
runs of one instance. It pins wave 11's four predicates per instance, the choice
each pair produces and the key that decides it — score for three of them,
the broader final check for the other two, the run index where everything ties —
and that the same journals twice produce byte-identical output.

### Grading and reporting

The evaluator keys its predictions by instance id, so one instance can carry
exactly one patch per grading. A matrix of n runs per instance is therefore n
gradings a side, one per round, plus one for the selected patches:

```sh
./grade-matrix.sh w12 all 5
```

| group | run ids | patches |
| --- | --- | --- |
| flows rounds | `w12-flows-r1` … `w12-flows-r5` | `patches/<id>-r<n>.patch` |
| codex rounds | `w12-codex-r1` … `w12-codex-r5` | `patches-codex/<id>-r<n>.patch` |
| selected | `w12-selected` | `selected/<id>.patch` |

`all` selects first and grades second. Running the selector after a grading
changes nothing about what it reads — it cannot name a report — but grading first
is the order that invites the mistake, so the driver does not offer it.

```sh
node matrix-report.mjs --prefix w12 --count 5
```

writes `matrix-report.json` and `matrix-report.md`: the per-instance reliability
matrix (n verdicts each side), best-of-n on both sides, selector quality, and the
single-attempt r1 columns that waves 3 through 11 reported, so the matrix can be
read against them.

**Disclosure obligations.** The two best-of-n columns are *not* the same
measurement, and the report says so on every line that carries them:

- **flows best-of-n is the verdict of the patch the selector chose**, from
  journals and patches alone, before anything was graded. It is a number the
  harness could produce in production.
- **codex best-of-n is an oracle**: the best verdict any of the n codex runs
  earned, so resolved when *any* of them resolved. The grader makes that choice
  after grading all n, and no codex run could make it. It is an upper bound on
  what a codex best-of-n would score, not a measured one. The cell takes the
  best of the n rather than r1's, so a side that shipped a real patch in four
  rounds is never printed as `empty` because its first round was.
- A comparison between them therefore favours codex by exactly the selector's
  miss rate, and the report prints the flows side's oracle too, so the gap
  between "the selector chose" and "an oracle would have chosen" is a number
  rather than an argument.
- **Selector quality** is that gap per instance: of the instances where at least
  one flows run resolved, `hit` where the selector took a resolving run and
  `miss` where it took another. An instance where nothing resolved is `n/a`,
  because there was nothing to hit.

The report also cross-checks the chosen patch against itself: the same bytes are
graded once in their own round and once in the selected set, and a disagreement
is a rig fault the report names rather than a result.

`fixtures/check-matrix-report.mjs`, in `verify.sh`, replays the generator over
`fixtures/matrix-reports.json` — the verdicts waves 7 through 11 and the drive's
four codex gradings actually recorded, arranged as five rounds. It pins the
reliability matrix, keeps `not graded` distinct from `empty patch`, and asserts
the oracle label and the rig-fault warning appear in the markdown.

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
  number on the same instance, same model, same budget, same container and
  **same prompt** is not a comparison. Add the codex result to
  `baseline/codex-comparison.json` when the sample grows.
- **Anything one harness is taught, both are taught.** The two prompts differ
  only where they name a harness's own tools — the `write` flow, and the Jujutsu
  colocation the flows CLI creates in its own workspace. Everything else,
  including the repository's test runner, is environment teaching and goes to
  both sides. `fixtures/check-prompts.mjs` lists the flows-only lines and fails
  on a sixth one, because this is the rule the rig has already broken once: see
  [The prompts](#the-prompts).
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
- **A best-of-n number names how it was chosen.** The flows column is the
  selector's pre-grading choice and the codex column is an oracle; a write-up
  that prints them side by side without saying which is which is claiming a win
  the measurement does not support. Say it in the sentence that carries the
  numbers, not in a footnote. See [Best-of-n](#best-of-n).
- **The selector never sees the answer.** It reads `journals/` and `patches/`
  and nothing else, and it runs before grading. A change that gives it any other
  input — the evaluator's report, the dataset row, a hand-written verdict —
  turns every best-of-n number the rig has ever produced into an oracle.
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
(`fixtures/check-capture.mjs`), the subject fingerprint
(`fixtures/check-subject.mjs`, which needs a built CLI: run `./preflight.sh`
first if `packages/cli/dist` is absent), and the whole best-of-n half: the
per-run naming rule (`fixtures/check-run-paths.mjs`), the matrix scheduler over
a stub harness command (`fixtures/check-matrix.mjs`), the journal-only selector
over two real waves (`fixtures/check-selector.mjs`), and the report generator
over recorded evaluator verdicts (`fixtures/check-matrix-report.mjs`). Run it
after touching `scorecard.ts`, `prices.ts`, the journal's event shapes,
`select-candidate.mjs`, `run-matrix.sh`, `matrix-report.mjs`, or anything under
`lib/`.

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
