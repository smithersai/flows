# `@flows/kernel`

This page is the public API reference for capability matching, permission decisions, durable grant handling, and permission-decorated host services. It does not provide an operating-system sandbox.

## Policy namespaces

| Namespace | Main public API |
| --- | --- |
| `Capability` | `Capability`, `CapabilityPattern`, `make`, `parse`, `format`, `formatPattern`, `matches`, `subsumes`, `tierOf`, `requiresIdempotencyKey` |
| `CapabilitySet` | `CapabilitySet` value; `fromPatterns`, `none`, `allows`, `intersect`, `equals`, `current`, and `attenuate` |
| `Permission` | `Rule`, `evaluate`, `PermissionRequired`, `PermissionDenied`, `GrantStoreError`, constructor helpers |
| `GrantEvent` | Schema-backed request, resolution, revocation, and envelope grant events |
| `GrantStore` | `GrantStore` service; `make`, `layer`, `makeNoop`, `layerNoop`; pending request and resolution types |
| `JournalGrantStore` | Journal-backed `GrantStore` construction and layer |
| `Workspace` | Workspace-root context used for exact path capabilities |

Rules are ordered and last-match-wins, except an effective configured deny is a hard veto. The default decision is `ask`.

```ts
const readWorkspace = new Permission.Rule({
  effect: "allow",
  pattern: new Capability.CapabilityPattern({
    action: "fs:read",
    resource: "/workspace/**"
  })
})

const decision = Permission.evaluate(
  [[readWorkspace]],
  Capability.make("fs:read", "/workspace/src/main.ts")
)
```

`GrantStore` resolutions are `once`, `run`, `remembered`, and `deny`. Journal persistence is explicit through `JournalGrantStore`; the base `makeNoop` is allow-all and should not be mistaken for a production policy.

## Decorated host namespaces

`FileSystem`, `Shell`, `Pty`, `Jj`, and `HttpClient` export kernel service tags and layers that depend on the corresponding raw host service plus `GrantStore` and related context. `Path` explicitly re-exports the pure path-service decision without a permission check.

`HostServices` composes the protected layer for the closed host service set. Use it at the application composition boundary:

```text
raw @flows/host service
        ↓
kernel decorator → GrantStore
        ↓
workflow-visible service
```

## Testing

`@flows/kernel/test/TestGrantStore` exports `layerAllow`, `layerDeny`, and `layerScripted`. The test module is a public deep import; internal modules are not.

See [Hosts and capabilities](../concepts/hosts-and-capabilities.md) and the [`@flows/host` reference](host.md).
