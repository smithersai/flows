# @smithers/kernel

Capability-enforcement layer between flows and `@smithers/host`. It owns
monotone authority, typed permission/grant decisions, journal-backed grants,
and permission-aware replacements for every protected Host service.

```sh
npm install @smithers/kernel
```

## Public API

The root exports these namespaces, also available from matching
`@smithers/kernel/*` subpaths.

| Namespace            | Public exports                                                                                                                                                                                                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Capability`         | `Action`, exact `Capability`, `PatternAction`, and `CapabilityPattern`; `make`, `format`, `formatPattern`, `parse`, `parsePattern`, `matches`, and `subsumes`; `EffectTier`, `TierOptions`, `tierOf`, and `requiresIdempotencyKey`.                                               |
| `CapabilitySet`      | `CapabilitySet`; `fromPatterns`, empty authority `none`, `allows`, `allowsPattern`, `intersect`, `equals`, ambient `current`, and monotone `attenuate`. No widening constructor or unrestricted value is public.                                                                  |
| `CapabilityEnvelope` | Serializable `CapabilityEnvelope` and its `version`; `CapabilityEnvelopeError`; `make`, `patternsOf`, `decode`, `encode`, monotone `apply`, `interpret`, and `interpreter`. Unrestricted authority is expressed by omitting the envelope, never by an envelope value.             |
| `Permission`         | `PermissionRequired`, `PermissionDenied`, `GrantStoreErrorCode`, and `GrantStoreError`; policy `RuleEffect`, `Rule`, and `evaluate`; constructors `permissionRequired` and `permissionDenied`.                                                                                    |
| `GrantEvent`         | `GrantTier`, `GrantScope`, `OnceGrant`, `RememberedGrant`, `RunGrant`, `DeniedGrant`, `EnvelopeGrant`, `GrantEventSchema`, `GrantEvent`, `decode`, and `encode`.                                                                                                                  |
| `GrantStore`         | `PendingRequest`, `Resolution`, `EnvelopeGrantOptions`, `Persist`, and `MakeOptions`; `Service` / `GrantStore` operations `check`, `reply`, `list`, and `grantEnvelope`; `isValidGrantPattern`, `isValidEnvelopePattern`, `make`, `layer`, allow-all `makeNoop`, and `layerNoop`. |
| `JournalGrantStore`  | `JournalGrantStoreOptions`; `make` and `layer` replay and persist grants through `Journal`.                                                                                                                                                                                       |
| `HostServices`       | Raw `HostService`, `HostServiceTags`, and `HostServiceIds`; permission-aware `ProtectedHostService` and `ProtectedHostServiceTags`; aggregate decorator `layer`.                                                                                                                  |
| `FileSystem`         | Permission-aware `File` and `FileSystem` interface/tag; `make`, `makeNoop`, `layerNoop`, `canonicalResource`, and decorator `layer`.                                                                                                                                              |
| `HttpClient`         | `HttpClientError`, permission-aware `HttpClient` interface/tag with `executeModel`; `make`, `makeNoop`, `layerNoop`, and decorator `layer`.                                                                                                                                       |
| `Shell`              | Permission-aware `Shell` interface/tag; `make`, `makeNoop`, `layerNoop`, and `layer`.                                                                                                                                                                                             |
| `Pty`                | Permission-aware `Pty` interface/tag; `make`, `makeNoop`, `layerNoop`, and `layer`.                                                                                                                                                                                               |
| `Jj`                 | Permission-aware `Jj` interface/tag; `make`, `makeNoop`, `layerNoop`, and `layer`.                                                                                                                                                                                                |
| `Path`               | Effect `Path` type/tag and explicit pass-through `layer`.                                                                                                                                                                                                                         |
| `Workspace`          | `Service` / `Workspace` root configuration; `make`, `layer`, relative test value `makeNoop`, and `layerNoop`.                                                                                                                                                                     |

The public `@smithers/kernel/test/TestGrantStore` subpath exports `layerAllow`,
`layerDeny(reason?)`, and `layerScripted(replies)`.

```ts
import { Capability, GrantStore } from "@smithers/kernel"
import { Effect } from "effect"

const program = Effect.gen(function*() {
  const grants = yield* GrantStore.GrantStore
  yield* grants.check(Capability.make("fs:read", "/workspace/README.md"))
}).pipe(Effect.provide(GrantStore.layerNoop))

Effect.runPromise(program)
```

`HostServices.layer` consumes the raw closed Host surface and provides guarded
FileSystem, Path, Shell, Pty, Jj, and HttpClient tags. Capability-bearing
operations retain `PermissionRequired | PermissionDenied | GrantStoreError` in
their error channels; HTTP consumers must use the kernel `HttpClient`, not the
raw Host transport.

See the [kernel reference](../../docs/reference/kernel.md),
[Permission Kernel](../../../docs/specs/Concepts/Permission%20Kernel.md),
[Trust Granularity](../../../docs/specs/Concepts/Trust%20Granularity.md),
[Effect Taxonomy](../../../docs/specs/Concepts/Effect%20Taxonomy.md), and
[Step Keys](../../../docs/specs/Concepts/Step%20Keys.md).
