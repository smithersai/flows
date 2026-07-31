# `@smithers/keys`

This page is the public API reference for canonical serialization, SHA-256 digests, and versioned step-key construction. The package is pure and does not access storage or execute flows.

## Import

```ts
import { Canonical, Digest, KeyMaterial, StepKey } from "@smithers/keys"
```

## `Canonical`

| Export | Purpose |
| --- | --- |
| `format` | Canonical format identifier, `flows-step-key-v1` |
| `serialize(value)` | Return `Result<string, CanonicalError>` |
| `CanonicalError` | Tagged error with stable canonicalization code |
| `CanonicalErrorCode` | Error-code type |

The serializer sorts object keys, normalizes strings to NFC, preserves array order, normalizes negative zero to zero, rejects non-finite numbers, rejects cycles, and rejects unsupported values.

## `Digest`

`Digest.digest(input)` computes a lowercase SHA-256 hex string from a string or `Uint8Array`.

## `StepKey`

| Export | Purpose |
| --- | --- |
| `StepKey` | Branded schema/type matching `sk1_` plus 64 lowercase hex characters |
| `ContentIdentity` | Full body/input/layer/capability/hermetic key material |
| `OrdinalIdentity` | Run-local `{ runId, parentScope?, ordinal, tier }` material |
| `content(identity)` | Produce a cross-run content key |
| `ordinal(identity)` | Produce a run-local ordinal key |
| `fromKeyMaterial(material, dependencyDigests)` | Resolve graph-local dependency references and produce a content key |
| `KeyMaterialError` | Missing dependency or non-content-material failure |

```ts
const key = StepKey.content({
  body: "compile-v3",
  inputs: { source: { digest: "sha256:source" } },
  layers: ["linux-amd64"],
  capabilities: { fs: ["fs:read:/workspace/src/**"] }
})
```

All constructors return Effect `Result`; use `Result.getOrThrow` only when the input is already trusted.

## `KeyMaterial`

`KeyMaterial.InputRef` represents a graph-local dependency by `nodeId`. `KeyMaterial.KeyMaterial` is either sealed content material or ordinal material. The package can resolve this structure, but no public planner in this repository produces it automatically.

See [Step keys and content addressing](../concepts/step-keys.md) and [The action graph](../concepts/action-graph.md).
