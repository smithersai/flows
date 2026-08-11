# @smthrs/kernel

The closed host boundary and the capability kernel over it. This package owns
the closed list of platform ports every side effect enters through, monotone
authority, typed permission/grant decisions, journal-backed grants, and
permission-aware replacements for every protected Host service.

The implementations behind those ports live in `@smthrs/platform-node`,
`@smthrs/platform-bun`, and `@smthrs/platform-browser`. Half the ports are
Effect's own tags — `FileSystem`, `Path`, and `ChildProcessSpawner` — so
`flows` supplies implementations of them rather than wrappers around them.

```sh
npm install @smthrs/kernel
```

## Public API

The root exports these namespaces, also available from matching
`@smthrs/kernel/*` subpaths.

| Namespace             | Public exports                                                                                                                                                                                                                                                                    |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Capability`          | `Action`, exact `Capability`, `PatternAction`, and `CapabilityPattern`; `make`, `format`, `formatPattern`, `parse`, `matches`, and `subsumes`; `EffectTier`, `TierOptions`, `tierOf`, and `requiresIdempotencyKey`.                                                               |
| `CapabilitySet`       | `CapabilitySet`; `fromPatterns`, empty authority `none`, `allows`, `intersect`, `equals`, ambient `current`, and monotone `attenuate`. No widening constructor or unrestricted value is public.                                                                                   |
| `Permission`          | `PermissionRequired`, `PermissionDenied`, `GrantStoreErrorCode`, and `GrantStoreError`; policy `RuleEffect`, `Rule`, and `evaluate`; constructors `permissionRequired` and `permissionDenied`.                                                                                    |
| `GrantEvent`          | `GrantTier`, `GrantScope`, `OnceGrant`, `RememberedGrant`, `RunGrant`, `DeniedGrant`, `EnvelopeGrant`, `GrantEventSchema`, `GrantEvent`, `decode`, and `encode`.                                                                                                                  |
| `GrantStore`          | `PendingRequest`, `Resolution`, `EnvelopeGrantOptions`, `Persist`, and `MakeOptions`; `Service` / `GrantStore` operations `check`, `reply`, `list`, and `grantEnvelope`; `isValidGrantPattern`, `isValidEnvelopePattern`, `make`, `layer`, allow-all `makeNoop`, and `layerNoop`. |
| `JournalGrantStore`   | `JournalGrantStoreOptions`; `make` and `layer` replay and persist grants through `Journal`.                                                                                                                                                                                       |
| `HostServices`        | Raw `HostService`, `HostServiceTags`, and `HostServiceIds`; permission-aware `ProtectedHostService` and `ProtectedHostServiceTags`; aggregate decorator `layer`.                                                                                                                  |
| `FileSystem`          | Permission-aware `File` and `FileSystem` interface/tag; `make`, `makeNoop`, `layerNoop`, `canonicalResource`, and decorator `layer`.                                                                                                                                              |
| `HttpClient`          | `HttpClientError`, permission-aware `HttpClient` interface/tag with `executeModel`; `make`, `makeNoop`, `layerNoop`, and decorator `layer`.                                                                                                                                       |
| `ChildProcessSpawner` | Permission-aware spawner interface/tag over `effect/unstable/process`; `SpawnError`, `OutputOptions`, `make`, `makeNoop`, `layerNoop`, and `layer`, which double-publishes onto Effect's own tag.                                                                                 |
| `CommandLine`         | `render`, `quote`, `cwd`, and `env` — one renderer shared by the `proc:spawn` capability resource and by the interpreters that execute the line.                                                                                                                                  |
| `Jj`                  | Permission-aware `Jj` interface/tag; `make`, `makeNoop`, `layerNoop`, and `layer`.                                                                                                                                                                                                |
| `Path`                | Effect `Path` type/tag and explicit pass-through `layer`.                                                                                                                                                                                                                         |
| `Workspace`           | `Service` / `Workspace` root configuration; `make`, `layer`, relative test value `makeNoop`, and `layerNoop`.                                                                                                                                                                     |

The public `@smthrs/kernel/test/TestGrantStore` subpath exports `layerAllow`,
`layerDeny(reason?)`, and `layerScripted(replies)`.

```ts
import { Capability, GrantStore } from "@smthrs/kernel"
import { Effect } from "effect"

const program = Effect.gen(function*() {
  const grants = yield* GrantStore.GrantStore
  yield* grants.check(Capability.make("fs:read", "/workspace/README.md"))
}).pipe(Effect.provide(GrantStore.layerNoop))

Effect.runPromise(program)
```

`HostServices.layer` consumes the raw closed Host surface and provides guarded
FileSystem, Path, ChildProcessSpawner, Jj, and HttpClient tags. Capability-bearing
operations retain `PermissionRequired | PermissionDenied | GrantStoreError` in
their error channels; HTTP consumers must use the kernel `HttpClient`, not the
raw Host transport.

See the [kernel reference](../../docs/reference/kernel.md),
[host and capability concepts](../../docs/concepts/hosts-and-capabilities.md), and
[step keys](../../docs/concepts/step-keys.md).
