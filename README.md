# Smithers Flows

Smithers Flows is a standalone durable-execution engine for reliable workflows. It provides a Temporal/Restate-class
execution foundation extracted from the `flows` monorepo, with no agent abstraction or agent-layer packages.

## Packages

- `@flows/host`
- `@flows/journal`
- `@flows/database`
- `@flows/kernel`
- `@flows/keys`
- `@flows/workflow-engine`
- `@flows/engine-store`
- `@flows/sync`
- `@flows/time-travel`
- `@flows/host-cloudflare`
- `@flows/host-vercel`

The `@flows/*` package names are retained. These packages form a closed workspace dependency set.

## Development

Install dependencies and typecheck every package:

```sh
npm install
npm run check
```

Package checks typecheck source files only. The copied `@flows/keys` test suite retains one type-only import from
`@flows/core`, which belongs to the agent layer and is intentionally not part of this repository.
