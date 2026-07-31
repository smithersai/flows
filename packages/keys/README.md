# @smithers/keys

`@smithers/keys` owns pure, synchronous step identity. It canonicalizes safe data and produces versioned `sk1_<sha256>` keys. It has no host services and rejects secret-bearing or non-canonical values.

`KeyMaterial` and `InputRef` are owned by this package. `@smithers/core` produces
structurally compatible planner values; keys does not import another
`@smithers/*` package.

## Exports

- `Canonical`: `format`, `serialize`, `CanonicalError`, and its stable rejection codes.
- `Digest`: synchronous SHA-256 digesting for strings and bytes.
- `StepKey`: branded schema, `content`, `fromKeyMaterial`, `ordinal`, identity input types, and `KeyMaterialError`.
- `KeyMaterial`: the shared `KeyMaterial` and `InputRef` contracts consumed by `StepKey.fromKeyMaterial`.

## Worked example

```ts
import { StepKey } from "@smithers/keys"
import { Result } from "effect"

const key = Result.getOrThrow(StepKey.content({
  body: { operation: "compile", version: 1 },
  inputs: { source: { digest: "0123" } },
  layers: ["base"],
  capabilities: { declared: ["fs:read:src/**"] }
}))
// sk1_<64 lowercase hex characters>
```

`content` is for sealed, reusable work. `ordinal` is deliberately run-local
for compensable, irreversible, and unsealed work. Constructors return
`Result` so non-canonical values and unresolved key material remain typed.
There are no layers to provide.

See the full contract in [`docs/reference/keys.md`](../../docs/reference/keys.md).
