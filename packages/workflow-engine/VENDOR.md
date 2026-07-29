# Vendored Effect workflow engine

## Fork point

- Upstream repository: `Effect-TS/effect`
- Upstream commit: `23e176a4f05ed3e81cc13a5d70111099692ea9a5`
- Upstream package: `effect@4.0.0-beta.102`
- Upstream source: `packages/effect/src/unstable/workflow`
- Vendored modules: `Workflow.ts`, `Activity.ts`, `WorkflowEngine.ts`,
  `DurableClock.ts`, `DurableDeferred.ts`, `DurableQueue.ts`,
  `WorkflowProxy.ts`, `WorkflowProxyServer.ts`, and `index.ts`

The baseline vendor commit rewrites imports that pointed elsewhere inside the
Effect repository to published `effect/*` package subpaths. Because Effect
strips its internal crypto helper from published declarations, that baseline
also carried temporary typecheck suppressions at the two helper imports; the
behavioral fork removes both imports and suppressions when identity moves to
`@flows/keys`. The behavioral fork is intentionally reviewable with
`git show`.

## Behavioral differences

### 1. Execution identity is caller-selected, with opt-in derivation

Upstream requires every workflow to declare `idempotencyKey`, hashes the
workflow tag and derived key, and always computes that ID inside `execute`.
Consequently equal payload keys join the same execution. Upstream proxy execute
and discard requests contain the workflow payload directly.

Flows makes `Workflow.make({ idempotencyKey })` optional and adds
`executionId?: string` to `Workflow.execute`. An explicit value always wins. If
it is absent, an opt-in idempotency key is digested synchronously with
`@flows/keys/Digest`. If neither exists, the workflow dies with the structured
`ExecutionIdRequired` defect before reading `WorkflowEngine`. The
`Workflow.executionId` helper has the same opt-in precondition. RPC and HTTP
execute/discard schemas carry `{ payload, executionId? }`, and both server
adapters forward the optional ID.

This prevents unrelated coding-agent runs with equal payloads from permanently
joining while retaining deterministic identity for workflows that deliberately
request it.

Upstream references:

- `Workflow.ts:59`, required definition field
- `Workflow.ts:80-84`, execute options without an execution ID
- `Workflow.ts:316-317`, tag/key hashing
- `Workflow.ts:343-363`, engine lookup followed by unconditional derivation
- `Workflow.ts:429-460`, required constructor option
- `WorkflowProxy.ts:68-75` and `WorkflowProxy.ts:148-155`, direct payload schemas
- `WorkflowProxyServer.ts:51-71` and `WorkflowProxyServer.ts:118-127`, forwarding
  direct payloads

### 2. Infrastructure interruption retry is explicit

Upstream sandwiches every activity effect in a default schedule that retries
any interrupt cause up to ten times and turns exhaustion into a defect.

Flows removes that default. Ordinary fiber interruption and workflow
suspension propagate immediately. `InfraInterrupt` is the explicit marker for
rebalancing or host-loss interruption, and only that marker consumes an
activity's opt-in `interruptRetryPolicy`. Exhaustion still becomes a defect.

This keeps user cancellation prompt while allowing a clustered engine to opt
into the recovery behavior it actually needs.

Upstream references:

- `Activity.ts:127-144`, activity retry option and unconditional wrapper
- `Activity.ts:181-201`, default exponential/spaced interrupt schedule

### 3. Workflow shape is deliberately not expanded

Upstream workflows contain their tag, schemas, annotations, idempotency
function, and suspension schedule. Flows changes only the idempotency function's
requiredness and execution behavior. It does not add description, capabilities,
placement, budgets, or other flow-authoring fields, and annotations remain
`Context.Context<never>`.

Those fields belong to the flows object model above the durable runtime.
Keeping them out makes future upstream rebases behavioral rather than
structural.

Upstream references:

- `Workflow.ts:53-60`, workflow fields
- `Workflow.ts:218-229`, type-erased workflow fields

### 4. Suspension polling keeps its fallback and gains an optional signal

Upstream reruns a suspended root execution after sleeping on
`Schedule.min([Schedule.exponential(200, 1.5), Schedule.spaced(30000)])`.

Flows preserves that schedule verbatim. `WorkflowEngine.Encoded` additionally
accepts optional `resumeSignal(workflow, executionId)`, and each fallback sleep
races that signal when supplied. `@flows/engine-store` leaves the optional
member unimplemented in v1.

This permits prompt journal-backed wakeups without making the first durable
store depend on a signal transport or removing the safe polling fallback.

Upstream references:

- `WorkflowEngine.ts:448-465`, suspended execution polling loop
- `WorkflowEngine.ts:555-558`, unchanged fallback schedule

### 5. Activity identity is supplied above the encoded seam

Upstream passes `(activity, attempt)` through `Encoded.activityExecute`; the
memory engine derives `${executionId}/${activity.name}/${attempt}` internally.
The `Activity.idempotencyKey` helper separately hashes execution ID, optional
attempt, and activity name.

Flows passes `{ activity, attempt, key, tier, metadata }` through the encoded
seam. `WorkflowEngine.makeUnsafe` computes `key` before dispatch with
`@flows/keys`: declared sealed identities use `StepKey.content`, while
compensable, irreversible, and identity-free sealed activities use stable
per-run ordinals. `metadata` carries an optional read/write-set descriptor
without interpretation below this package boundary. The memory implementation
indexes memo state only by `(key, attempt)`. Durable clock and queue internals
use the same ordinal allocator, and no implementation derives identity from an
activity name.

`Activity.make` adds `tier` (default `"sealed"`), optional `idempotencyKey`,
and opaque `metadata`. Compensable dispatch requires the local
`SnapshotBoundary` hook (`snapshot`, `restore`, `diff`) and restores before a
retry. The interface carries
`// TODO(piece-6): bind to @flows/kernel Jj in @flows/engine-store`; this package
does not import `@flows/kernel`. An irreversible retry without a declared
idempotency key dies with structured
`IrreversibleRetryRequiresIdempotencyKey` before redispatch.

This eliminates replay collisions caused by reused or renamed activity names,
keeps key computation identical for memory and durable engines, preserves
write-set metadata for enforcement below the seam, and prevents unsafe
double-sends.

Upstream references:

- `Activity.ts:123-176`, activity construction without tier/key metadata
- `Activity.ts:239-262`, name-derived helper
- `Activity.ts:310-321`, dispatch before encoded execution
- `WorkflowEngine.ts:296-338`, encoded activity seam
- `WorkflowEngine.ts:471-483`, typed adapter forwarding name-bearing activity
- `WorkflowEngine.ts:691-715`, memory key derivation from execution ID/name
- `DurableClock.ts:100-104`, internal short-sleep activity
- `DurableQueue.ts:203-226`, internal name-derived queue identity

## Deliberate non-changes

- `Workflow.annotations` remains `Context.Context<never>`; open metadata does
  not expand the workflow shape (`Workflow.ts:58`).
- Activity exits remain schema encoded and decoded across the engine boundary
  (`Activity.ts:135-175`, `WorkflowEngine.ts:471-483`).
- `Workflow.intoResult` retains upstream scope closure, defect capture,
  interrupt filtering, and the `Suspended` value (`Workflow.ts:651-713`).
- Compensation and workflow-scope finalization are unchanged
  (`Workflow.ts:779-858`).
- `DurableDeferred`, including base64url `Token` encoding and external
  completion, is unchanged (`DurableDeferred.ts:268-653`).
- Durable deferreds, clock scheduling, durable queue workers, proxy resume
  operations, and schema codecs remain present. Only their identity transport
  and execute/discard envelope changed.
- The upstream exponential/spaced suspension schedule remains the fallback
  (`WorkflowEngine.ts:555-558`).
- No description, capability, placement, budget, failure-policy, graph,
  external-event, or token-budget field was added to `Workflow` or the encoded
  seam.
