# flows

## Correction note (2026-08-18)

This file is copied from the outer repository at `/Users/williamcory/flows/CLAUDE.md`.
Two paths it names do not exist in this worktree. Read them from the outer
repository instead.

- The spec vault: `/Users/williamcory/flows/docs/specs/`. This worktree has
  `docs/` but no `docs/specs/`.
- The reference corpus: `/Users/williamcory/flows/reference/`, which holds the
  `effect`, `opencode`, `mastra`, `baml`, `plue`, `bazel`, and `temporal`
  clones. This worktree has no `reference/`. The clones are read-only; never
  edit them.

Build-system work in this worktree also follows `BUILDSYS-PLAN.json`,
`CORRECTIONS.md`, and `DECISIONS.md` at the repository root. `CORRECTIONS.md`
overrides `DECISIONS.md` wherever they disagree.


`flows` is a coding-agent harness where **everything is a flow**. It is
being written **from scratch in Effect.ts**. It is _not_ a port of `pi`.

`AGENTS.md` holds the development rules inherited with the `pi` tree (style,
commands, dependency policy, git). They still apply to code in `packages/`.
This file adds the rules specific to how `flows` is designed and built.

## Read the spec vault first

`docs/specs/` is an Obsidian vault and is the source of truth for the design.
Start at `docs/specs/Home.md`, then `HQ.md` for what is in flight. Follow
`Meta/Vault Conventions.md` when you edit it — every `[[wikilink]]` must
resolve, and `bun .smithers/lib/ddd/vaultCheck.ts` enforces that.

Key decision to know before writing any code: `Concepts/Effect Harness.md`.
`pi` is **reference code**. Read it, do not modify it, do not port its callback
and `EventEmitter` plumbing.

## MANDATORY: consult the reference corpus before designing a subsystem

We keep a shelf of reference implementations. **Before you design or implement
any subsystem, find the closest prior art on the shelf and read it.** Do not
design from memory, and do not invent a shape that one of these repos has
already shipped. Say in your write-up which reference you read and where you
deviated from it.

`reference/` clones are shallow, **gitignored, and read-only** — never edit
them. If a clone is missing, restore it with the commands in
`docs/specs/Research/Reference Corpus 2026-07-27.md`.

| Reference     | Path                                 | Consult it for                                                                                                                                                                                                                                                                                                                                               |
| ------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Effect v4** | `reference/effect`                   | The runtime itself. `packages/effect/src/unstable/ai/` (LanguageModel, Tool, Toolkit, Prompt, Response, Chat, McpServer) and `packages/effect/src/unstable/workflow/` (Workflow, Activity, DurableClock, DurableDeferred, WorkflowEngine). Also `unstable/{rpc,cluster,persistence,eventlog,http,process,sql,socket}`.                                       |
| **opencode**  | `reference/opencode`                 | **A shipping coding-agent harness already written in Effect 4** — the closest prior art that exists. `packages/core/src/effect/` (Layer/DI conventions), `session/` (agent loop as durable state), `background-job.ts`, `permission/`, `tool/`, `pty/`, `control-plane/`, and `packages/llm/` (their own provider layer). Their `AGENTS.md` and `specs/v2/`. |
| **pi**        | _removed from tree_ (in git history) | Harness behaviour and hard-won provider quirks. Evidence extracted into `docs/specs/Research/Pi Reference Findings 2026-07-27.md` — the note is now the canonical reference.                                                                                                                                                                                 |
| **mastra**    | `reference/mastra`                   | Feature taxonomy and agent/loop API ergonomics. **Not** Effect — use it as a scope checklist, never as a style guide.                                                                                                                                                                                                                                        |
| **baml**      | `reference/baml`                     | Schema-first prompting, coercing imperfect model output into declared types, evals as a language feature, and `baml-schema-wasm` as WASM-boundary prior art.                                                                                                                                                                                                 |
| **plue**      | `reference/plue`                     | Our own Smithers control plane (Go, jj-native): runs, workspaces, agent sandboxes — the remote half of the local/remote seam.                                                                                                                                                                                                                                |
| **bazel**     | `reference/bazel`                    | Skyframe (`src/main/java/com/google/devtools/build/skyframe/`): keyed, memoizing, parallel, incremental evaluation — prior art for `keys`, `engine`, and the step cache. Its `GraphTester`-style test harness is the model for deterministic evaluation tests.                                                                                                 |
| **temporal**  | `reference/temporal`                 | The production bar for durable workflow execution: `service/history/` (mutable state, event sourcing), shard/rangeID fencing (prior art for RunStore fencing), timer queues, `common/backoff` retries, reset/rebuild (prior art for `time-travel`).                                                                                                           |

Routing rule of thumb:

- Building anything with tools, prompts, or model calls → `reference/effect`
  `unstable/ai` **and** `reference/opencode` `packages/llm`. These two took
  opposite paths on the same problem; know which you are following and why.
- Building durability, replay, or resumption → `reference/effect`
  `unstable/workflow` **and** `reference/temporal` (history, fencing, timers,
  reset).
- Building evaluation, caching, or invalidation → `reference/bazel` Skyframe.
- Building sessions, background runs, permissions, or host services →
  `reference/opencode` `packages/core/src`.
- Building the prompt/output contract or evals → `reference/baml`.
- Wondering whether we have missed a concept entirely → `reference/mastra`.

## Everything copies the effect repo

New `flows` code in `packages/` mirrors the **effect repo itself** —
`reference/effect` is the template for file structure, module layout, export
naming (`make`/`makeNoop`/`layerNoop`/`layer`), error conventions, JSDoc
(`@since`/`@category`), and tooling. Do not invent a convention effect already
has; open the corresponding effect file and copy its shape. Details in
`AGENTS.md` ("New flows packages mirror the effect repo").

## Effect rules

- Effect is **v4** (`effect@4.0.0-beta.*`). Package layout changed: most of the
  old `@effect/*` ecosystem now lives at `effect/unstable/*`. Do not follow
  Effect 3 tutorials or install `@effect/platform`, `@effect/rpc`,
  `@effect/cluster`.
- **The AI core is `effect/unstable/ai`, not `@effect/ai`.** Only providers are
  separate packages (`@effect/ai-anthropic`, `@effect/ai-openai`, …).
- In Effect generators, bind services to named variables before calling their
  methods. No nested service yields — not
  `yield* (yield* Foo.Service).bar()`. (Adopted from opencode's style guide;
  it is the most common Effect readability failure.)
- Host access goes through a `Layer`, always — filesystem, process spawn, PTY,
  env, clock, random, crypto, sockets. Browser support is a hard requirement,
  and a layer is how it is met. Anything that cannot be made browser-safe gets
  a ticket, never a silent exception (`Concepts/Tickets Not Exceptions.md`).
- Cancellation is scope closure and fiber interruption, not a threaded
  `AbortSignal` and not manual `aborted` checks.

## Do not

- Do not port `pi`'s `EventBus`, `onUpdate` callback threading, or manual
  `signal?.aborted` checks. Effect replaces all of it.
- Do not modify anything under `reference/`.
- Do not resolve an open question in the vault by guessing. If you learn the
  answer, record how you learned it.
