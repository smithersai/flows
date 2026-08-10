# @smthrs/kernel

Capability enforcement at the host boundary. The kernel exports its own service tags that mirror the host tags and check a capability against a grant store before delegating.

```ts
import { Capability, Permission } from "@smthrs/kernel"

const rule = new Permission.Rule({
  effect: "allow",
  pattern: new Capability.CapabilityPattern({ action: "fs:read", resource: "/workspace/**" })
})
```

## Entry points

| Import | Source | Platform |
| --- | --- | --- |
| `@smthrs/kernel` | [src/index.ts](https://github.com/smithersai/flows/blob/main/packages/kernel/src/index.ts) | any |
| `@smthrs/kernel/test/TestGrantStore` | [src/test/TestGrantStore.ts](https://github.com/smithersai/flows/blob/main/packages/kernel/src/test/TestGrantStore.ts) | any |

## Capability

[src/Capability.ts](https://github.com/smithersai/flows/blob/main/packages/kernel/src/Capability.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `Action` | type | `fs:read`, `fs:write`, `net:get`, `net:post`, `model:call`, `proc:spawn`, `jj:status`, `jj:diff`, `jj:snapshot`, `jj:restore`, `jj:workspace-add`, `jj:workspace-forget` |
| `Capability` | schema class | `action` plus exact `resource` |
| `CapabilityPattern` | schema class | `action` (or a wildcard `PatternAction`) plus a resource glob |
| `PatternAction` | type | pattern action literals |
| `make` | constructor | builds an exact capability |
| `format`, `formatPattern`, `parse` | functions | the `action:resource` text form |
| `matches` | predicate | pattern against exact capability, whole-resource match |
| `subsumes` | predicate | returns `false` when containment cannot be proven syntactically |
| `EffectTier` | type | `sealed`, `compensable`, `irreversible` |
| `TierOptions` | interface | `workspaceRoot` |
| `tierOf` | function | classifies a capability into a tier |
| `requiresIdempotencyKey` | predicate | true for the irreversible tier |

## CapabilitySet

[src/CapabilitySet.ts](https://github.com/smithersai/flows/blob/main/packages/kernel/src/CapabilitySet.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `CapabilitySet` | interface | the ambient authority envelope |
| `fromPatterns`, `none` | constructors | |
| `allows` | predicate | |
| `intersect`, `attenuate` | functions | authority can only narrow |
| `equals` | predicate | |
| `current` | effect | reads the ambient set |

## Permission

[src/Permission.ts](https://github.com/smithersai/flows/blob/main/packages/kernel/src/Permission.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `Rule` | schema class | `effect` plus `pattern` |
| `RuleEffect` | type | `allow`, `deny`, `ask` |
| `evaluate` | function | applies rules to a capability |
| `PermissionRequired`, `PermissionDenied` | classes | typed failures in the error channel |
| `permissionRequired`, `permissionDenied` | constructors | |
| `GrantStoreError`, `GrantStoreErrorCode` | class + codes | |

## GrantStore and GrantEvent

| Export | Source | Notes |
| --- | --- | --- |
| `GrantStore.GrantStore`, `Service`, `make`, `layer`, `makeNoop`, `layerNoop` | [src/GrantStore.ts](https://github.com/smithersai/flows/blob/main/packages/kernel/src/GrantStore.ts) | `makeNoop` is an explicit allow-all seam |
| `GrantStore.PendingRequest`, `Resolution`, `EnvelopeGrantOptions`, `MakeOptions`, `Persist` | same | request and resolution shapes |
| `GrantStore.isValidGrantPattern`, `isValidEnvelopePattern` | same | pattern admission |
| `GrantEvent.OnceGrant`, `RunGrant`, `RememberedGrant`, `DeniedGrant`, `EnvelopeGrant` | [src/GrantEvent.ts](https://github.com/smithersai/flows/blob/main/packages/kernel/src/GrantEvent.ts) | durable decision schemas |
| `GrantEvent.GrantEventSchema`, `GrantEvent`, `GrantTier`, `GrantScope`, `decode`, `encode` | same | |
| `JournalGrantStore.make`, `layer`, `JournalGrantStoreOptions` | [src/JournalGrantStore.ts](https://github.com/smithersai/flows/blob/main/packages/kernel/src/JournalGrantStore.ts) | persists decisions as `flows.kernel.grant.*` journal events |
| `TestGrantStore.layerAllow`, `layerDeny`, `layerScripted` | [src/test/TestGrantStore.ts](https://github.com/smithersai/flows/blob/main/packages/kernel/src/test/TestGrantStore.ts) | scripted behavior for suites |

## Decorated host services

Each module below exports the service interface, its tag, `make`, `makeNoop`, `layerNoop`, and a `layer` that decorates the matching raw host service.

| Module | Source | Guarded actions |
| --- | --- | --- |
| `FileSystem` | [src/FileSystem.ts](https://github.com/smithersai/flows/blob/main/packages/kernel/src/FileSystem.ts) | `fs:read`, `fs:write`; also exports `File` and `canonicalResource` |
| `Shell` | [src/Shell.ts](https://github.com/smithersai/flows/blob/main/packages/kernel/src/Shell.ts) | `proc:spawn` |
| `Jj` | [src/Jj.ts](https://github.com/smithersai/flows/blob/main/packages/kernel/src/Jj.ts) | the six `jj:*` actions |
| `HttpClient` | [src/HttpClient.ts](https://github.com/smithersai/flows/blob/main/packages/kernel/src/HttpClient.ts) | `net:get`, `net:post`; also exports `HttpClientError` |
| `Path` | [src/Path.ts](https://github.com/smithersai/flows/blob/main/packages/kernel/src/Path.ts) | none; pure path manipulation is not checked |
| `Workspace` | [src/Workspace.ts](https://github.com/smithersai/flows/blob/main/packages/kernel/src/Workspace.ts) | supplies the root used to resolve path capabilities |

## HostServices

[src/HostServices.ts](https://github.com/smithersai/flows/blob/main/packages/kernel/src/HostServices.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `HostService`, `HostServiceTags`, `HostServiceIds` | type + consts | the raw surface the kernel wraps |
| `ProtectedHostService`, `ProtectedHostServiceTags` | type + const | the decorated surface flow code receives |
| `layer` | layer | provides every protected service over a raw host bundle |

## What the kernel does not do

It is a capability check at the adapter call site. It does not sandbox the operating system, and it does not observe reads or writes that bypass the decorated services. Hermetic execution additionally needs a `StepBoundary` implementation.
