# Smithers Flows

Smithers Flows is an unreleased, standalone Effect-based durable-execution engine. It provides typed workflows,
journal-backed execution state, content-addressed activities, capability-checked host effects, synchronization, and
time-travel protocols.

## Documentation

Start with the [documentation index](docs/README.md). It includes a recommended reading order, concept guides,
deployment limitations, and one reference page for every package.

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
