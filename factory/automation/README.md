# factory/automation/

The agentic half of the factory's GitHub side. One TypeScript entry per job,
plus the pure modules those entries are built from.

The workflows that run these entries are generated, not hand-written. They are
declared in the root `BUILD.ts` through `Smithers.GithubAutomation` and rendered
into `.github/workflows/gen.*.yml`; the drift check runs under `smthrs ci`. The
design is in the spec vault: `docs/specs/Concepts/Github Automation.md`.

## Running an entry

Every entry runs the same way locally and from Actions. It needs `gh`
authenticated, `GITHUB_REPOSITORY`, and the subject issue or pull request:

```sh
GITHUB_REPOSITORY=smithersai/flows ISSUE_NUMBER=42 node factory/automation/intake.ts
GITHUB_REPOSITORY=smithersai/flows PR_NUMBER=87  node factory/automation/review.ts
```

From Actions the subject comes from `GITHUB_EVENT_PATH` instead, or from the
`issue` input on a `workflow_dispatch` run, which the generated workflow hands
the entry as `ISSUE_NUMBER`. Entries that call the model also need
`ANTHROPIC_API_KEY` and the agent CLI; the generated workflows install it
(`npm install --global @anthropic-ai/claude-code`) on every agent job whose
declaration says `engine: true`.

There is no build step. The entries are plain `.ts` run by Node 22's type
stripping, and they import only `node:*` builtins, so a runner needs nothing
installed beyond the workspace.

## Entries

| Entry              | Workflow                  | Does                                                        |
| ------------------ | ------------------------- | ----------------------------------------------------------- |
| `intake.ts`        | `gen.issue-intake.yml`    | Decodes a new report, looks for duplicates, comments.       |
| `poc.ts`           | `gen.poc-loop.yml`        | Writes the repro pair and commits it.                       |
| `poc-run.ts`       | `gen.poc-loop.yml`        | Runs the repro in the no-secrets sandbox.                   |
| `poc-publish.ts`   | `gen.poc-loop.yml`        | Posts the result, classifies blockers, moves the labels.    |
| `advance.ts`       | `gen.issue-reply.yml`     | Advances the state on a reporter's reply.                   |
| `proof.ts`         | `gen.repro-proof.yml`     | Fails the PR unless its repro fails at the base and passes at the head. |
| `review.ts`        | `gen.pr-review.yml`       | Rubric review over the diff, posted as one review.          |
| `fix.ts`           | `gen.verified-fix.yml`    | Queues a verified repro, runs the lane, opens the PR.       |
| `reverify.ts`      | `gen.repro-reverify.yml`  | Unparks blocked repros and re-runs verified ones.           |

## Modules

| Module        | Holds                                                                 |
| ------------- | --------------------------------------------------------------------- |
| `agent.ts`    | The engine seam. `ask` and `askJson`; `claude -p` behind them.        |
| `github.ts`   | The event payload and the `gh` wrapper. Argv arrays, never a shell.   |
| `schema.ts`   | The door decode. One `Report`, bounded, from either payload shape.    |
| `labels.ts`   | The state machine. Pure: it decides transitions, `github.ts` applies them. |
| `blockers.ts` | Failure classification, and the blocker issue's title and body.       |
| `memory.ts`   | The issue-memory corpus. See `factory/memory/README.md`.              |
| `repro.ts`    | The `.md` + `.ts` pair and the result the sandbox records.            |
| `queue.ts`    | Rendering a `factory/queue/` item from a verified report.             |
| `shell.ts`    | Running commands and the git operations, plus `isEntryPoint`.         |

## The rules these entries follow

**Prefer a script.** The agent is for judgment: deciding whether two reports
are the same bug, writing a repro from prose, reading an ambiguous reply. Every
other step is a `gh` call. An agent that only formats a comment is a slower,
less predictable shell script.

**The credential never meets untrusted execution.** `poc-run.ts` is the one
entry that executes reporter-derived steps. Its job is declared
`untrustedInput` in the root `BUILD.ts`, so the renderer leaves it with no
secret, no workflow token, and read-only permissions. It cannot talk to GitHub
at all; it writes a result file and `poc-publish.ts` does the talking. Anything
added to `poc-run.ts` that needs a token belongs in `poc-publish.ts` instead.

**`main()` is guarded.** Every entry ends with
`if (isEntryPoint(import.meta.url)) main()`, so importing one to test its
helpers does not run it.

**Labels are the state.** There is no side database. A run that dies halfway
leaves the state where a person can see it.

**Bookkeeping reaches `main`.** A commit that stays on the runner is state the
next run cannot see, so every entry that commits — the memory corpus, the
repro pairs, the recorded results — pushes with `pushMain()`, which survives
one concurrent push by rebasing once. The fix lane is the exception: it pushes
its own lane branch, never `main`.

## Tests

The pure modules are tested with the Node test runner, the same way
`scripts/*.test.mjs` are, and the whole directory is typechecked:

```sh
node --test 'factory/automation/*.test.ts'
pnpm exec tsc -p factory/automation/tsconfig.json
```

Both run in `ci.yml` and in `release.yml`, and both are declared as gates on
the `GithubCiGen` contract targets in the root `BUILD.ts`, so neither can be
dropped from a pipeline without the contract check failing.

`tsconfig.json` here points `typeRoots` at `packages/targets/node_modules/@types`
because this directory is not a workspace package and has no `node_modules` of
its own. That is the cost of keeping the entries dependency-free; the
alternative was a package manifest and a lockfile entry for code that imports
nothing.

The entries themselves are not tested here: they are thin, and everything in
them worth pinning has been pulled into a module that is. What is covered is
the label state machine, blocker classification, memory read and write, the
door schema, the repro pair, the proof gate's claim reading, and the agent
seam.
