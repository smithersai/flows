# @smthrs/keys

Pure canonical serialization, SHA-256 digests, and step-key construction. No Effect services, no workspace dependencies, no platform access.

```ts
import { StepKey } from "@smthrs/keys"
import * as Result from "effect/Result"

const key = Result.getOrThrow(StepKey.content({
  body: "compile/v3",
  inputs: { tsconfig: { digest: "sha256-of-tsconfig" }, mode: "production" },
  layers: ["node-22", "typescript-6.0.3"],
  capabilities: { declared: ["fs:read:/workspace/**"] }
}))
// "sk1_<64 lowercase hex>"
```

## Entry point

| Import | Source | Platform |
| --- | --- | --- |
| `@smthrs/keys` | [src/index.ts](https://github.com/smithersai/flows/blob/main/packages/keys/src/index.ts) | any |

## Canonical

[src/Canonical.ts](https://github.com/smithersai/flows/blob/main/packages/keys/src/Canonical.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `format` | const | the canonical format version tag |
| `serialize` | function | versioned, type-tagged string; sorts object keys, preserves array order, NFC-normalizes strings |
| `CanonicalError` | class | carries a `CanonicalErrorCode` |
| `CanonicalErrorCode` | type | rejection reasons |

`serialize` rejects `undefined`, bigint, symbol, function, non-finite numbers, sparse arrays, class instances, accessor properties, cycles, symbol-keyed properties, and Effect `Redacted` values.

## Digest

[src/Digest.ts](https://github.com/smithersai/flows/blob/main/packages/keys/src/Digest.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `digest` | function | lowercase SHA-256 hex of a string |

## KeyMaterial

[src/KeyMaterial.ts](https://github.com/smithersai/flows/blob/main/packages/keys/src/KeyMaterial.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `InputRef` | type | `Literal`, `Ref`, `Pending` |
| `KeyMaterial` | interface | graph-local material a planner would produce |

## StepKey

[src/StepKey.ts](https://github.com/smithersai/flows/blob/main/packages/keys/src/StepKey.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `StepKey` | branded type + schema | `sk1_` plus a 64-character digest |
| `DigestInput` | interface | `{ digest: string }` |
| `digestInput`, `isDigestInput` | constructor + guard | distinguishes digest inputs from literals |
| `EnvironmentIdentity` | interface | resolved layers and capability identity |
| `ContentIdentity` | interface | `body`, `inputs`, `layers`, `capabilities`, optional `hermetic`, optional `environment` |
| `OrdinalIdentity` | interface | `runId`, `parentScope`, `ordinal`, `tier` |
| `InputRef`, `KeyMaterial` | types | re-exported graph shapes |
| `KeyMaterialError` | class | includes `missing_dependency` and `non_content_material` |
| `content` | function | content key from a `ContentIdentity` |
| `ordinal` | function | run-local key from an `OrdinalIdentity` |
| `fromKeyMaterial` | function | resolves graph-local refs to dependency digests, then keys |

## Key selection

| Activity shape | Key |
| --- | --- |
| sealed with a content identity | `StepKey.content` |
| sealed without an identity | `StepKey.ordinal` with tier `unsealed` |
| compensable | `StepKey.ordinal` with tier `compensable` |
| irreversible | `StepKey.ordinal` with tier `irreversible` |

Set-like fields are NFC-normalized, deduplicated, and sorted. Literal inputs and digest inputs carry different canonical tags. A node id passed through `fromKeyMaterial` is a lookup address, so it never enters the hash.

## What a key proves

A content key says the output is a function of the declarations that went into it. It cannot observe a hidden file read or an undeclared network call. Cross-run reuse also requires boundary evidence, which `@smthrs/engine-store` checks before it admits a cache row.
