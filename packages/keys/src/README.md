# `@smthrs/keys`

Creates stable identities for workflow steps.

- `Digest.ts` — synchronous, isomorphic SHA-256.

  ```typescript
  const digest: (input: string | Uint8Array) => string
  ```

  Used by `@smthrs/engine` for execution identity, `@smthrs/engine-store` for cache and file evidence, and the agent harness for prompt, context, and composition identity.

- `KeyMaterial.ts` — the planner's unhashed step description.

  ```typescript
  interface KeyMaterial {
    body: unknown
    inputs: ReadonlyArray<InputRef>
    layers: ReadonlyArray<string>
    capabilities: ReadonlyArray<string>
    effects: unknown
    placement: unknown
  }
  ```

  Produced by `@smthrs/core` graph planning and consumed by `StepKey.fromKeyMaterial` in the agent engine harness and testing packages.

- `StepKey.ts` — final reusable or run-local keys.

  ```typescript
  const content: (identity: ContentIdentity) => Result<StepKey, CanonicalizeError>
  const fromKeyMaterial: (
    material: KeyMaterial,
    dependencies: Readonly<Record<string, string>>
  ) => Result<StepKey, KeyMaterialError | CanonicalizeError>
  const ordinal: (identity: OrdinalIdentity) => Result<StepKey, CanonicalizeError>
  ```

  Uses `@smthrs/canonical` before hashing. `@smthrs/engine` uses `content` and `ordinal` for activity identity. The agent engine harness uses `content` and `fromKeyMaterial` for durable calls and cached sandbox executions.
