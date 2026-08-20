# alpha-ui-baseline — orchestration doctrine eval

Baseline report for the eval suite that scores an orchestrator against the
five doctrine rules in `ui.PROMPT.md`. Machine-readable results:
`evals/alpha-ui-baseline.json`.

## What the suite is

| File | Role |
|------|------|
| `workflows/alpha-ui-evals.tsx` | Single-task workflow. Input: one orchestration-scenario description. Output row `judgment`: `rule`, `verdict`, `action`, `rationale`. |
| `evals/alpha-ui-cases.jsonl` | 17 scenarios with expected judgments. |
| `tests/alpha-ui-evals.test.tsx` | Graph/schema/case-file test, registered in the `.smithers` `test` script. |

The workflow's `DOCTRINE_RULES` enum is the grading vocabulary:

- `parallel-lanes` — implementation lanes run in parallel over isolated
  worktrees; only the merge queue serializes, and it serializes landing.
- `single-pre-merge-review` — exactly one pre-merge review per lane; a second
  pass, a second reviewer, or a re-review of applied fixes is refused.
- `immediate-land` — land the moment review clears: fetch, rebase-first, gates,
  push. Never batch, never hold a cleared lane, never rewrite main.
- `post-land-polish-loop` — every landed commit polishes until an **explicit**
  LGTM; findings become fix-forward commits that re-enter the queue.
- `human-tasks-gated` — human tasks only after both independent panel verifiers
  return PRODUCTION-READY.

Because the verdict enum is two-valued, every rule carries at least one
`refuse` case and at least one `proceed` case. A model that answers a single
verdict per rule cannot score above chance; the test
`the case file covers every doctrine rule in both directions` enforces that
property so the suite cannot silently degrade into a one-sided quiz.

## How to run it

```bash
cd .smithers
bun install
bunx smthrs eval workflows/alpha-ui-evals.tsx \
  --cases evals/alpha-ui-cases.jsonl \
  --suite alpha-ui-baseline \
  --report evals/alpha-ui-baseline.json \
  -j 4 --force
```

Pass `--dry-run` to validate the case file and plan the run ids without
spending a single agent call.

Structural checks, no agents and no network:

```bash
cd .smithers && bun run test
```

## Baseline result

Run label `20260816192412-e8a95a58`, 2026-08-16. Judge pool:
`claude-sonnet-5` with `claude-fable-5` as fallback.

| Metric | Value |
|--------|-------|
| Cases | 17 |
| Passed | 17 |
| Failed | 0 |
| Inconclusive | 0 |
| Case-run status | 17 × `finished` |
| Wall clock | 123 s at concurrency 4 |
| Median case | 29 s |

Per rule, all passing:

| Rule | Cases |
|------|-------|
| `parallel-lanes` | 3 |
| `single-pre-merge-review` | 3 |
| `immediate-land` | 4 |
| `post-land-polish-loop` | 4 |
| `human-tasks-gated` | 3 |

**Read the 17/17 as a floor, not a ceiling.** A saturated baseline proves the
harness grades end to end and that the doctrine, as written into the judge
prompt, is unambiguous enough to apply — it does not discriminate between
orchestrators. The suite earns its keep as a regression gate: it fails when the
doctrine text drifts, when a rule name is renamed out from under the case file,
or when a weaker judge model is substituted. To turn it into a ranking
instrument, harden it along these axes, in this order:

1. **Cross-rule conflict cases.** Scenarios where two rules pull opposite ways
   (a cleared lane whose rebase would land a commit that a still-open polish
   loop is about to revert). The current cases each have one governing rule.
2. **Near-miss `proceed` cases.** Courses that are doctrine-compliant but read
   as violations at a glance (landing lane 7 of 8 while lane 3 is red — still
   correct, because lanes are independent).
3. **LLM-judge assertions on `action`.** The deterministic grader only checks
   `rule` and `verdict`; `action` and `rationale` are unscored. The runner
   supports a per-case `judge: { instructions, threshold }` block, which would
   score whether the replacement course is actually executable.
4. **Weaker judge models.** Re-run the suite against a small model to find the
   discriminating floor.

## Two smithers papercuts hit while running this

Both are real defects a non-us user would hit. Neither is fixed here — this
lane owns `.smithers/` in this repo, not the smithers CLI.

1. **`smthrs eval` rejects comments in `.jsonl` case files, but the shared
   dataset parser accepts them.** `@smthrs/scorers/evalCases.js` `tryParseJsonl`
   documents and skips `#`-prefixed comment lines. The path `smthrs eval`
   actually takes, `@smthrs/cli/src/eval-suite.js` `parseCasesText`, does not —
   it `JSON.parse`s every non-blank line and throws
   `INVALID_JSON: Invalid JSONL case at line 1`. A commented case file is
   documented-valid and unrunnable. Same file: the reported line number comes
   from the post-`filter(Boolean)` index, so it is wrong for any file with a
   blank line. Fix: have `parseCasesText` delegate to `parseEvalDataset`, or at
   minimum skip `#` lines and report the pre-filter line number. That is why
   `alpha-ui-cases.jsonl` carries no header comment and this file exists.

2. **The default `--report` path doubles when the command runs from inside
   `.smithers/`.** The default is the literal `.smithers/evals/<suite>.json`
   resolved against `process.cwd()`. Running the documented command from
   `.smithers` (which is where a workflow-relative `workflows/...` path
   requires you to be) writes `.smithers/.smithers/evals/alpha-ui-baseline.json`.
   Fix: resolve the default against the smithers anchor directory the way
   workflow discovery does. Workaround, used above: pass `--report` explicitly.
