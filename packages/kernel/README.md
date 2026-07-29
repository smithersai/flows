# @flows/kernel

The capability kernel: monotone authority, typed grant requests, and Effect
layers that enforce permissions at every Host boundary. `HostServices.layer`
publishes kernel tags whose error channels retain
`PermissionRequired | PermissionDenied | GrantStoreError`. Capability-bearing
consumers use those tags rather than narrower raw tags.

## Kernel rules

1. **Adapters are the gate.** Each capability-bearing operation is checked in
   its decorator layer immediately before delegation. There is no voluntary
   tool-level check to forget.
2. **Ambient authority only shrinks.** A private fiber-local reference holds
   the current `CapabilitySet`; `current` can inspect it and `attenuate`
   intersects it with the child envelope. The reference itself is not public,
   so callers cannot replace it with wider authority.
3. **Grants attach to a request, not code.** In attended mode an `ask` creates
   a pending request and suspends the checking fiber on its `Deferred`. In
   unattended mode the same check fails immediately with the exact
   `PermissionRequired`. A reply grants once, for the run, or as remembered
   policy; it can also deny. The journal-backed store persists every reply
   before it can resume a waiter.

```ts
import { Effect } from "effect"
import { Capability, GrantStore, Workspace } from "@flows/kernel"

const program = Effect.gen(function*() {
  const store = yield* GrantStore.GrantStore
  yield* store.check(Capability.make("fs:read", "/workspace/README.md"))
}).pipe(
  Effect.provide(GrantStore.layerNoop),
  Effect.provide(Workspace.layer("/workspace"))
)

Effect.runPromise(program)
```

## Capabilities

Capabilities have the grammar `action:resource`. `action` is exact and
`resource` is adapter-normalized: canonical filesystem paths, process command
text, jj identifiers, a lowercase HTTP `URL.host` including a nondefault port,
or `host/model-id` for model calls.

| Action                                                                 | Adapter operation                             | Tier                                                   |
| ---------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------ |
| `fs:read`                                                              | read, stat, glob, watch                       | sealed                                                 |
| `fs:write`                                                             | mutations and writable handles                | compensable inside the workspace; irreversible outside |
| `net:get`                                                              | HTTP GET, HEAD                                | sealed                                                 |
| `net:post`                                                             | HTTP POST, PUT, PATCH, DELETE, OPTIONS, TRACE | irreversible                                           |
| `model:call`                                                           | model-provider request                        | sealed                                                 |
| `proc:spawn`                                                           | Shell and Pty creation                        | irreversible                                           |
| `jj:status`, `jj:diff`                                                 | read-only jj operations                       | sealed                                                 |
| `jj:snapshot`, `jj:restore`, `jj:workspace-add`, `jj:workspace-forget` | mutating jj operations                        | compensable                                            |

Grant replies cannot cross those action or tier boundaries. For example, a
`net:get` request cannot be resolved with `net:*`, and a compensable
inside-workspace write cannot be resolved with `fs:write:**`. Envelope grants
likewise require exact actions and cannot use a filesystem glob spanning both
sides of the workspace boundary.

Resource wildcards follow opencode's whole-resource matching, including the
trailing-command rule (`npm *` also matches `npm`). Windows drive-path
resources match case-insensitively on every platform; all other resources are
case-sensitive. This deterministic drive-path rule deliberately replaces
opencode's `process.platform` switch so browser and Node planning agree.

## Effect tiers

| Tier         | Meaning                               | Retry / time travel                                    |
| ------------ | ------------------------------------- | ------------------------------------------------------ |
| sealed       | A function of declared inputs         | freely retryable; cacheable                            |
| compensable  | Mutates jj-captured workspace state   | snapshot then retry; restore can compensate            |
| irreversible | The external world retains the result | retry only with an idempotency key; record, never undo |

An irreversible effect must declare an idempotency key before retry.
`net:post` is never silently retried.

## Capability sets

`CapabilitySet` is a conjunction of disjunctive pattern groups: every group
must match, while one pattern within each group is sufficient. This represents
intersections exactly without synthesizing broader globs.

```text
allows(A ∩ B, cap) = allows(A, cap) && allows(B, cap)
A ∩ top = A
A ∩ A = A
```

Root fibers begin at top authority. The underlying Context reference and the
top constructor are private; attenuation is monotone and there is intentionally
no public replacement or widening operation.

## Grant stores

`GrantStore.check` evaluates the current capability ceiling and policy. An
attended `ask` waits on a request-local `Deferred`; `reply` resolves it with
`once`, `run`, `remembered`, or `deny`. Interrupting the checking fiber removes
its pending request and exits by fiber interruption. Closing the store scope
fails detached waiters with typed `PermissionDenied` and clears the request
map. A check racing store closure fails through `GrantStoreError` code
`store_closed`; lifecycle failures are never defects. Unattended `ask` fails
immediately with `PermissionRequired`.

Run grants remain bounded by the ceiling captured with their request and carry
the active plan digest as a journaled amendment. Activating one resolves every
already-pending request it covers, not only the request whose reply created
it. `once` grants are journaled as audit evidence but never replayed. Run
grants and run envelopes replay from the operational `runId` only for the same
plan digest. Remembered grants and remembered envelopes replay through a
dedicated `policyRunId`.

`grantEnvelope({ planDigest, patterns, scope })` is the plan-approval
primitive. Its digest must equal the store's active `planDigest`; authority for
another plan is rejected before persistence or activation. Scope defaults to
`run`; `remembered` persists the envelope as remembered predicate grants while
retaining its origin plan digest. Journal replay accepts kernel events only
from the configured `sourceId`, requires the journal envelope `eventType` to
equal the decoded payload type, and revalidates every pattern. Initial envelope
approval is not emitted again when the same run resumes.

With `JournalGrantStore`, once, run, remembered, denial, and envelope decisions
are journaled and flushed before activation. Replies, envelope grants, pending
registration, and teardown share one store mutex, so concurrent replies cannot
journal contradictory decisions and closure cannot strand a waiter. The
`Workspace` service is required by both the store and decorators; there is no
`"/"` fallback.

## Host decoration

`HostServices.layer` consumes the shared closed `@flows/host` surface and
publishes distinct permission-aware `FileSystem`, `HttpClient`, `Shell`,
`Pty`, and `Jj` tags. `Path` is an explicit pure pass-through. The filesystem,
shell, pty, and jj decorators also rebind their legacy Host or Effect tags to
the guarded implementation while migrations are in progress. HTTP is stricter:
neither Effect's `HttpClient` nor the Host `HttpTransport` is republished,
because their fixed error channels would erase permission failures. HTTP
consumers must require `@flows/kernel/HttpClient`.

`HostServices.HostServiceIds` is the exact stable slot list re-exported from
`@flows/host`. `ProtectedHostServiceTags` maps those six slots, in order, to the
permission-aware tags; the final raw `HttpTransport` slot maps to the kernel
`HttpClient`. Planners resolve implementation identities for these slots into
core key-material `layers`.

The current public `@flows/host` contract exports each service as a subpath.
Kernel runtime code imports only the closed `HostServices` contract and the
`Shell`, `Pty`, `Jj`, error, and single-hop `HttpTransport` subpaths; it never
imports a Node platform bundle. Integration tests provide the actual Host tags
and prove interception. The browser-bundle
test bundles the complete kernel root and its journal contract subpaths while
externalizing only Effect, so a Node-only transitive import fails instead of
being masked.

Filesystem checks resolve existing path components through
`FileSystem.realPath`. A symlink escaping the workspace therefore requests the
outside canonical resource. Access to a pre-existing hard-linked file fails
closed because the current Host contract cannot prove all names for its inode.
Opened files re-check reads and writes on the handle.

HTTP decoration consumes `HttpTransport` as a private layer requirement; its
contract is exactly one request and one response with redirect following
disabled. The transport tag is not re-exported by the kernel. Redirect
handling is composed above the protected client, causing each target to
re-enter the guard. `executeModel`
requests `model:call` for the normalized host/model resource instead of
conferring general `net:post` authority. An opaque lower `HttpClient` is not
accepted as a dependency.

## Composition

```ts
import { Journal } from "@flows/journal"
import { HostServices, JournalGrantStore, Workspace } from "@flows/kernel"
import { Layer } from "effect"

declare const journal: Layer.Layer<Journal.Journal>
declare const platform: Layer.Layer<HostServices.HostService>

const workspace = Workspace.layer("/workspace")
const grants = JournalGrantStore.layer({
  runId: "run-42",
  policyRunId: "policy",
  sourceId: "cli",
  planDigest: "sha256:..."
}).pipe(
  Layer.provide(journal),
  Layer.provide(workspace)
)

const dependencies = Layer.mergeAll(platform, grants, workspace)
const runtime = Layer.provide(HostServices.layer, dependencies)
```

The same `workspace` layer value feeds classification and path normalization,
so the store and filesystem cannot silently use different defaults.

## Errors

| Error                | Code                                                                                             | Meaning                                             |
| -------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| `PermissionRequired` | `permission_required`                                                                            | an unattended request needs resolution              |
| `PermissionDenied`   | `permission_denied`                                                                              | current authority or policy rejected the capability |
| `GrantStoreError`    | `duplicate_request`, `request_not_found`, `journal_failed`, `store_closed`, `invalid_resolution` | grant-store lifecycle or durability failure         |

These stable codes are public contracts.

## Test helpers

`@flows/kernel/test/TestGrantStore` (not on the root barrel) exports
`layerAllow` (alias of `GrantStore.layerNoop`), `layerDeny(reason?)`, and
`layerScripted(replies)` which consumes `once` / `run` / `remembered` / `deny`
resolutions in order and rejects once the script is exhausted.

## Prior-art verification

| Source                                                                                                            | Adopted                                                                                                                                                                                                                                                                                        | Deliberate differences                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reference/opencode/packages/core/src/permission.ts` and `permission/saved.ts`                                    | Request-local `Deferred`, uninterruptible registration/reply, decline-all teardown finalizer, configured rules reduced last-match-wins before effective-deny precedence, combined last-match-wins `allow`/`deny`/`ask` rules, whole-resource wildcards, and the trailing-command wildcard rule | A deny reply resolves only its request, not every pending waiter; the store exposes pending requests through `list` but does not publish opencode's `Asked`/`Replied` UI-bus events; Windows drive-path matching is deterministic rather than conditional on `process.platform`. |
| `reference/effect`                                                                                                | Flat modules, namespace exports, `Context.Service`, `Layer`, Schema errors, JSDoc categories, source export map, public publish map, and emitted ESM declarations                                                                                                                              | The flows package template adds a CJS compatibility artifact; the referenced Effect packages publish ESM.                                                                                                                                                                        |
| `reference/flue/packages/runtime/src/sandbox.ts`                                                                  | One central path-resolution seam across filesystem operations                                                                                                                                                                                                                                  | Flue trusts the selected virtual/local/remote sandbox and threads `AbortSignal`; flows adds call-level capability checks and uses fiber interruption only.                                                                                                                       |
| `../smithers/packages/sandbox/src/SandboxEgressConfig.ts` and `packages/time-travel/src/EffectHandlerRegistry.ts` | Destination-scoped egress and the distinction between reversible workspace state and external residue informed host scopes and effect tiers                                                                                                                                                    | Smithers approves and contains whole agent boxes; it has no per-call capability kernel.                                                                                                                                                                                          |
| `docs/specs/Research/Pi Reference Findings 2026-07-27.md`                                                         | Host-shaped execution seams and stable error codes                                                                                                                                                                                                                                             | Pi has no permission system; its optional `tool_call` hook and OS sandbox are not treated as enforcement. Its `AbortSignal` threading is intentionally replaced by Effect interruption.                                                                                          |

## Contract gaps pending reconciliation

1. Original Host tag signatures cannot show permission errors; use the widened
   kernel tags when handling them. HTTP raw tags are never republished; legacy
   filesystem/process tags remain guarded runtime aliases during migration.
2. The permission-aware HttpClient and `Workspace` are local contracts. Host
   owns only the raw single-hop HTTP transport and has no workspace-root
   service.
3. Journal has no cross-run grant projection. Remembered policy and remembered
   envelopes use a dedicated `policyRunId`; authoritative storage requires
   SqlJournal overflow policy `reject`. `packages/journal` and
   `packages/database` are owned by the concurrent run and remain unmodified
   here.
4. The Host filesystem has no atomic `openat`/`O_NOFOLLOW` boundary. The kernel
   canonicalizes existing ancestors and rejects hard-linked files, but a
   platform adapter should eventually expose an atomic confined-path primitive
   to close path-swap races.

## Package output

Development exports point at `src`. `npm run build` emits ESM plus declarations
under `dist/esm` and non-bundled CJS modules under `dist/cjs`;
`publishConfig.exports` selects the correct artifact for `import`, `require`,
and TypeScript. The CJS modules require one another instead of bundling every
entry independently, so root and subpath consumers share class and service-tag
identity.

## Design notes

- [Permission Kernel](../../docs/specs/Concepts/Permission%20Kernel.md) — the
  owning vault note: adapters as the gate, attended/unattended asks, grant
  scopes.
- [Trust Granularity](../../docs/specs/Concepts/Trust%20Granularity.md)
- [Effect Taxonomy](../../docs/specs/Concepts/Effect%20Taxonomy.md)
- [Step Keys](../../docs/specs/Concepts/Step%20Keys.md)
- [Plan](../../docs/specs/Specs/Plan.md)

Public API reference: [`docs/reference/kernel.md`](../../docs/reference/kernel.md).
