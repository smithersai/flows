# apps/ui flow-library reuse — receipt

The goal was for this app to consume the workspace libraries in `packages/`
instead of hand-rolled abstractions, in two headline outcomes: every
interactive capability becomes a real flow paired to a handler through
`@smthrs/harness` `FlowBinding`, and the in-browser agent loop becomes the
workspace harness cell loop.

Outcome one landed in full. Outcome two is blocked on a library change and is
recorded below with the blocker pinned as a passing test.

## Where the app was when this run started

The brief described an `apps/mvp` whose every `@smthrs/*` dependency was
`file:vendor/smthrs/*` on effect `4.0.0-beta.102`. That is not the tree that
exists. The app is `apps/ui`, `vendor/smthrs/` and `scripts/vendor-smthrs.mjs`
are already gone, every `@smthrs/*` dependency is already `workspace:*`, effect
is already `4.0.0-rc.108`, and `DESIGN.md` §14's dependency-law paragraph
already describes the workspace reality. Stage 1 of the brief was therefore
already complete before this run, and no vendoring work was needed. The
`parseSubmit`/`commandHead` refactor the brief flagged as uncommitted was also
already committed; it is preserved and folded into the new boundary.

Everything below is stages 2, 3, and 4.

## What moved to library reuse

### Stage 2 — flows as the capability model (landed, gates green)

`src/mainview/flows/Flows.ts` declares all 88 capabilities with `Flow.make`
from `@smthrs/core` — name, description, capability claims, and typed
payload/success schemas — and pairs each with its controller call through
`FlowBinding.make` from `@smthrs/harness`. The hand-rolled `Command` interface
with its `execute(args?: string)` member is gone.

- **Registry entries are `{ binding, metadata }`.** `metadata` carries only
  UI-catalog concerns: summary copy, `hidden`, `aliasOf`, the slash args hint,
  and requirement ids. Flow identity lives on the declaration.
- **The trigger axis is `modelInvocable`.** `trigger: "user"` became
  `userOnly: true` on the declaration, which `FlowBinding.DescriptorOptions`
  projects as `modelInvocable: false`. User-only flows are absent from the
  agent's catalog structurally rather than by a filter.
- **`COMMAND_CAPABILITIES` moved onto the declarations.** The map that used to
  live in `chain/CommandCatalog.ts` is gone; `outbound:launch`,
  `session:net-read`, `approve:self`, and the `app:act` default are declared
  where the flow is.
- **The parallel catalog projection is deleted.** The catalog disclosed to the
  agent is `registry.callable()` — the registry narrowed to model-invocable
  entries — and the same bindings answer the calls. What remains as
  `chain/FlowCatalog.ts` is a thin shape adapter for the legacy chain runtime
  with no capability table, trigger filter, or description copy of its own.
- **Argument parsing happens once, at the composer boundary.**
  `src/mainview/flows/SlashPayload.ts` turns `/name <text>` into the flow's
  typed payload. No handler parses `args?: string` any more; a text that cannot
  be parsed is refused before the binding runs.
- **Every trigger shares one dispatch.** `Commands.ts` builds a `Cell.Call` and
  invokes `binding.run`, so button, pill, slash menu, and agent call all reach
  the capability the same way the cell loop will.

Behaviour contracts and their tests are unchanged: one run path for
button/pill/slash/agent, requirement deferral with durable resume for
user-invoked flows, honest failures for agent-invoked flows with unmet
requirements, the user-only guard, slash-menu ranking and its cap, and the
launch-blocker parity gate.

### Stage 3 — the harness cell loop in the browser (groundwork landed, swap blocked)

`src/mainview/chain/AppEngine.ts` implements `EngineLike`, the port the
`CellTurn`/`CellHarness` loop runs on, over what the browser has: `sealStep`
streams the relay-backed `@smthrs/model` seat the app already had, `call`
dispatches to the `FlowBinding` catalog, `record` performs and journals a
controller read, and `suspend` parks. As the brief allowed, durability is
app-side over the persisted TanStack collections rather than the durable flow
engine; mounting that engine in the browser is left as a follow-up and no
library was changed to force it.

`src/mainview/chain/AppEngine.test.ts` runs the real loop in this environment
and passes. It proves the three ports compose — the QuickJS browser sandbox
evaluates cells, a scripted seat drives frames, and a cell's `ctx.call` is
answered by the binding with its payload decoded and its success encoded back.

**The swap did not land.** `CellTurn` screens a flow's declared capabilities
with `Capability.parse`, whose action set is closed (`fs:*`, `net:*`,
`model:call`, `proc:spawn`, `jj:*`), and an unparseable claim is refused for
*any* envelope — including `{ action: "*", resource: "**" }`. Every flow in
this app claims the vocabulary that carries DESIGN.md §14's three-tier approval
policy, which has no honest fs/net/proc equivalent, so under the cell loop all
88 would be refused. The third test in `AppEngine.test.ts` pins exactly this.

Rather than drop the approval policy to get the loop running, the agent loop
stays on `ChainRuntime` and the change is requested as entry 2 below. What
remains unbuilt behind that blocker: the `AgentEvent` → `AgentTurnFrame` fold,
the steering-source adapter over the existing queue, approval-park and
background-lineage mapping, and boot resume on the new loop.

### Stage 4 — flow branding rename (landed, gates green)

Registered names lose the workflow prefix (`workflow.create` → `flow.create`
and its list/run/repo-choose/run-stop/run-retry siblings), `/commands` becomes
`/flows`, the card kind `workflow-run` becomes `flow-run`,
`src/mainview/commands/` becomes `src/mainview/flows/`, and `data-command` /
`data-commands` become `data-flow` / `data-flows` along with their dataset
accessors and CSS selectors. `APP_SCHEMA_VERSION` went 8 → 9 instead of
migrating persisted rows.

Deliberately not renamed: the controller methods naming the REMOTE domain
object (`createWorkflow`, `runWorkflow`, `listWorkspaceWorkflows`) — the
workspace really does run workflows, and only the app's own capability names
are flows — and the agent tool spec still named `commands`, which is a
model-facing prompt contract rather than a registered name. Also untouched per
the brief: smithers-orchestrator references, historical receipts, `reference/`,
imported upstream API names, and the chat.smithers.sh wire paths.

## Workarounds taken

1. **`pnpm install` could not run.** `packages/tsflows/package.json` carries an
   unresolved jj rebase conflict (`<<<<<<< conflict 1 of 1`) in the working
   copy, which makes the manifest invalid JSON and aborts every pnpm command.
   It is not this port's file and `packages/` was read-only, so it was not
   resolved. To add the one dependency, `@smthrs/harness` was linked into
   `apps/ui/node_modules/@smthrs/` the same way pnpm links every other
   workspace sibling, and the lockfile was regenerated with the conflict file
   temporarily set to its committed content and then restored byte-for-byte.
   The committed lockfile hunk is exactly the `apps/ui` → `@smthrs/harness`
   link; an unrelated `platform-node-next` hunk that regeneration also produced
   was left out of the commit because it belongs to another lane's uncommitted
   edits.
2. **`FlowBinding` refusal framing is stripped in the app.** `unframe()` in
   `flows/Commands.ts` removes the deterministic `` `Flow ${name} failed: ` ``
   prefix so a human sees the handler's own copy. It fails safe. Entry 1 below
   is the honest fix.
3. **The chain adapter survives stage 2.** `chain/FlowCatalog.ts` still restates
   bindings in `@smthrs/chain-next`'s `Catalog.Entry` shape, because the chain
   runtime is still the agent loop. It holds no source of truth of its own and
   is deleted when stage 3's blocker clears.

## Gates

Run in `apps/ui`, all green at the final commit:

- `bun run typecheck` — clean.
- `bun test src` — 468 pass, 0 fail, across 50 files.
- `bun run build` — succeeds.

Note on the suite: `Wave11.test.ts` and `Wave12.test.ts` contain wall-clock
tests that time out under machine load at bun's default 5s. They were already
flaky before this work (a pre-change baseline run showed 10 such failures under
load and 1 when run alone). They pass consistently at `--timeout 20000`.

No migrated package's own gates were touched; the only new dependency is
`@smthrs/harness`, consumed unmodified.

## LIBRARY-CHANGE-REQUESTS.md, in full

Two entries exist. `apps/ui/LIBRARY-CHANGE-REQUESTS.md` is the source of truth;
its complete contents at the time of writing are reproduced here.

---

# Library change requests from the apps/ui flow port

`packages/*` was read-only for this port. Each entry below is a place where the
app took a workaround instead of changing a library. Will approves library
changes personally.

## 1. `FlowBinding` refusals lose the raw handler message

- **File**: `packages/harness/src/FlowBinding.ts`
- **What**: `make`'s runner wraps every handler failure as
  `` `Flow ${descriptor.name} failed: ${describe(produced.failure)}` `` and puts
  that single string in `CallResult.message`. The original failure value is not
  carried anywhere on the result.
- **Why it matters here**: the app dispatches user-facing affordances through
  the same bindings the agent calls. A handler's failure IS the copy the human
  reads ("send needs the text to submit"), so the framing prefix is noise on the
  UI surface while being useful on the cell surface. With only the framed string
  available, the host has to re-derive the raw message by stripping a prefix it
  reconstructs from the flow name — a string contract between two modules that
  the type system does not check, and that silently degrades to the framed text
  if the library ever rewords it.
- **Workaround taken**: `apps/ui/src/mainview/flows/Commands.ts` has an
  `unframe(name, message)` helper that strips the exact
  `` `Flow ${name} failed: ` `` prefix when present and otherwise passes the
  message through. It is correct today and fails safe (worst case the human sees
  the framed text), but it duplicates a library string.
- **Proposed diff sketch**: add an optional raw field to `Cell.CallResult` and
  populate it in `FlowBinding.make`:

  ```diff
   export class CallResult extends Schema.Class<CallResult>("flows/harness/Cell/CallResult")({
     outcome: Schema.Literals(["success", "failure"]),
     value: Schema.Json,
  -  message: Schema.optional(Schema.String)
  +  message: Schema.optional(Schema.String),
  +  /** The handler's own refusal, unframed, for hosts that surface it directly. */
  +  detail: Schema.optional(Schema.String)
   }) {}
  ```

  ```diff
  -const refused = (message: string): CallResult => new CallResult({ outcome: "failure", value: null, message })
  +const refused = (message: string, detail?: string): CallResult =>
  +  new CallResult({ outcome: "failure", value: null, message, ...(detail === undefined ? {} : { detail }) })
  ```

  with the handler-failure branch passing `describe(produced.failure)` as
  `detail`. Nothing existing reads `detail`, so the change is additive.

## 2. The cell loop's capability envelope refuses any host capability vocabulary

- **Files**: `packages/harness/src/CellTurn.ts` (the screen at ~line 353) and
  `packages/capability/src/Capability.ts` (`parse`, `Action`).
- **What**: before dispatching a cell's flow call, `CellTurn` filters the
  descriptor's declared capabilities:

  ```ts
  const refused = descriptor.capabilities.filter((declared) =>
    Option.match(Capability.parse(declared), {
      onNone: () => true,                                   // <- unparseable ⇒ refused
      onSome: (capability) => !CapabilitySet.allows(envelope, capability)
    })
  )
  ```

  `Capability.parse` recognizes only a closed action set — `fs:read`,
  `fs:write`, `net:get`, `net:post`, `model:call`, `proc:spawn`, and the `jj:*`
  operations — and requires a `namespace:operation:resource` shape. Any other
  claim string parses to `None` and takes the `onNone: () => true` branch, so it
  is refused no matter how wide the run's envelope is. There is no envelope
  value, including `{ action: "*", resource: "**" }`, that admits it.
- **Why it matters here**: every flow in this app claims the vocabulary that
  carries DESIGN.md §14's three-tier approval policy — `app:act` (free),
  `session:net-read` (asks once per session), `outbound:launch` (always asks),
  `approve:self` (structurally denied to the agent). These are policy tiers
  about the app's own surface; they have no honest `fs:`/`net:`/`proc:`
  equivalent, and re-labelling `flow.create` as `net:post` would both
  misdescribe it and discard the tier the policy keys on. Under the cell loop
  every app flow is therefore refused, which is what blocks swapping
  ChainRuntime for `CellTurn`/`CellHarness`.
  `apps/ui/src/mainview/chain/AppEngine.test.ts` pins this as a passing test.
- **Workaround taken**: none that preserves the policy. The agent loop stays on
  ChainRuntime, whose `Catalog` carries capability strings opaquely and lets
  `chain/Policy.ts` decide the tier. Declaring the app's flows with empty
  `capabilities` would let the cell loop run, but it would silently drop the
  approval policy, so it was not done.
- **Proposed diff sketch**: let the host supply the vocabulary rather than
  hard-coding it. The smallest version keeps `Capability.parse` as the default
  and makes the unparseable branch a host decision:

  ```diff
   export interface Options {
     ...
  +  /**
  +   * Screens a declared capability the capability package cannot parse.
  +   * Defaults to refusing, which is today's behaviour.
  +   */
  +  readonly admitForeignCapability?: ((claim: string) => boolean) | undefined
   }
  ```

  ```diff
   const refused = descriptor.capabilities.filter((declared) =>
     Option.match(Capability.parse(declared), {
  -    onNone: () => true,
  +    onNone: () => !(input.admitForeignCapability?.(declared) ?? false),
       onSome: (capability) => !CapabilitySet.allows(envelope, capability)
     })
   )
  ```

  A host that says nothing keeps the current strict behaviour; this app would
  admit its four policy claims and keep enforcing their tiers where it already
  does. A larger alternative — extending `Capability.Action` with an
  application-defined namespace — would also work but changes a security-
  relevant closed set, so the host-callback version is proposed first.
