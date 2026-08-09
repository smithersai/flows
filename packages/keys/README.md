# @smthrs/keys

Pure, synchronous identity primitives for flows. The package canonicalizes safe
data and derives versioned content-addressed or run-local step keys without any
host service requirements.

```sh
npm install @smthrs/keys
```

## Public API

The root exports four namespaces, also available from matching
`@smthrs/keys/*` subpaths.

| Namespace     | Public exports                                                                                                                                                                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Canonical`   | `format` identifies the canonical format. `serialize(value)` returns a `Result`; `CanonicalError` and `CanonicalErrorCode` describe rejected values.                                                                                                                      |
| `Digest`      | `digest(string \| Uint8Array)` returns a synchronous lowercase SHA-256 digest.                                                                                                                                                                                            |
| `KeyMaterial` | Shared `KeyMaterial` and `InputRef` planner contracts.                                                                                                                                                                                                                    |
| `StepKey`     | Branded `StepKey` schema/type; `content`, `fromKeyMaterial`, and `ordinal` constructors; nominal `DigestInput`, `digestInput`, and `isDigestInput`; `ContentIdentity`, `EnvironmentIdentity`, `OrdinalIdentity`, `InputRef`, and `KeyMaterial` types; `KeyMaterialError`. |

```ts
import { StepKey } from "@smthrs/keys"
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
[step keys](../../docs/concepts/step-keys.md).
