# Step keys and content addressing

This page defines how `@flows/keys` creates deterministic activity identities and how those identities control replay and cache reuse. It also states the limits of what a key proves.

## Two key classes

Every step key is `sk1_` followed by a lowercase SHA-256 digest.

### Content key

A content key can be reused across executions:

```ts
import { StepKey } from "@flows/keys"
import { Result } from "effect"

const key = Result.getOrThrow(
  StepKey.content({
    body: "compile-typescript/v3",
    inputs: {
      tsconfig: { digest: "sha256-of-tsconfig" },
      mode: "production"
    },
    layers: ["node-22", "typescript-6.0.3"],
    capabilities: {
      declared: ["fs:read:/workspace/**", "fs:write:/workspace/dist/**"]
    },
    hermetic: {
      readSet: [{ path: "/workspace/tsconfig.json", digest: "sha256-of-tsconfig" }],
      writeSet: ["/workspace/dist/**"],
      boundaryMode: "hard"
    }
  })
)
```

Set-like fields are NFC-normalized, deduplicated, and sorted. Literal inputs and digest inputs receive different canonical tags.

### Ordinal key

An ordinal key is local to one run:

```ts
const key = Result.getOrThrow(
  StepKey.ordinal({
    runId: "run-42",
    parentScope: "checkout",
    ordinal: 3,
    tier: "compensable"
  })
)
```

Use ordinals for compensable, irreversible, or otherwise unsealed work. The activity name is intentionally absent.

## Canonical serialization

`Canonical.serialize` produces a versioned, type-tagged string. It normalizes strings and sorts object keys while preserving array order. It rejects values that cannot safely produce stable keys:

- `undefined`, bigint, symbol, or function;
- non-finite numbers;
- sparse arrays;
- class instances and accessor properties;
- cycles;
- symbol-keyed properties;
- Effect `Redacted` values.

Secrets should never be unwrapped into key material. A rejected redacted value is a correctness and confidentiality guard.

## Graph-local dependencies

`StepKey.fromKeyMaterial` accepts literal and graph-local input references. It replaces every referenced node ID with the dependency digest supplied by the caller. The node ID is therefore a lookup address, not part of the result identity.

Only `kind: "sealed"` material can become a content key. Missing dependency digests fail with `missing_dependency`; other kinds fail with `non_content_material`.

The repository does not currently ship the planner that produces a whole dependency-ordered `KeyMaterial` graph.

## Activity key selection

`@flows/workflow-engine` chooses:

```text
sealed + idempotencyKey → StepKey.content
sealed without identity → StepKey.ordinal(tier = unsealed)
compensable             → StepKey.ordinal(tier = compensable)
irreversible            → StepKey.ordinal(tier = irreversible)
```

The computed key is passed into the encoded engine. `@flows/engine-store` then uses `Digest.digest(key)` as the attempt and cache database address.

## What changes a content key

A key changes when canonicalized body, inputs, layers, capabilities, or hermetic declaration changes. It does not change merely because an activity’s display name changes.

Use a semantic body version rather than function source text. The library does not fingerprint closures or modules for you.

## A key is a claim, not enforcement

A content key says “this output is a function of these declarations.” It cannot detect a hidden file read or undeclared network call. Honest cross-run reuse additionally requires:

- Host access through guarded services;
- a production `StepBoundary`;
- hard boundary enforcement;
- output capture and replay;
- no detected deviation.

Those enforcement pieces are why `EngineStore` refuses cache admission without boundary evidence. See [workflows and the action graph](action-graph.md) and [host adapters and capabilities](hosts-and-capabilities.md).
