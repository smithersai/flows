# @smithers/keys

Pure, synchronous identity primitives for flows. The package canonicalizes safe
data and derives versioned content-addressed or run-local step keys without any
host service requirements.

```sh
npm install @smithers/keys
```

## Public API

The root exports four namespaces, also available from matching
`@smithers/keys/*` subpaths.

| Namespace     | Public exports                                                                                                                                                                                                                                     |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Canonical`   | `format` identifies the canonical format. `serialize(value)` returns a `Result`; `CanonicalError` and `CanonicalErrorCode` describe rejected values.                                                                                               |
| `Digest`      | `digest(string \| Uint8Array)` returns a synchronous lowercase SHA-256 digest.                                                                                                                                                                     |
| `KeyMaterial` | Shared `KeyMaterial` and `InputRef` planner contracts.                                                                                                                                                                                             |
| `StepKey`     | Branded `StepKey` schema/type; `content`, `fromKeyMaterial`, and `ordinal` constructors; nominal `DigestInput`, `digestInput`, and `isDigestInput`; `ContentIdentity`, `OrdinalIdentity`, `InputRef`, and `KeyMaterial` types; `KeyMaterialError`. |

```ts
import { StepKey } from "@smithers/keys"
import { Result } from "effect"

const key = Result.getOrThrow(StepKey.content({
  body: { operation: "compile", version: 1 },
  inputs: { source: StepKey.digestInput("0123") },
  layers: ["base"],
  capabilities: { declared: ["fs:read:src/**"] }
}))
```

`content` is for sealed reusable work. `ordinal` is run-local for compensable,
irreversible, and otherwise unsealed work. Constructors return `Result` so
non-canonical values remain typed failures.

See the [keys reference](../../docs/reference/keys.md) and
[Step Keys](../../../docs/specs/Concepts/Step%20Keys.md).
