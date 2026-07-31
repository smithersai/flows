# Smithers Flows

Smithers Flows is an unreleased, standalone Effect-based durable-execution engine. It provides typed flows,
journal-backed execution state, content-addressed activities, capability-checked host effects, synchronization, and
time-travel protocols.

## Documentation

Start with the [documentation index](docs/README.md). It includes a recommended reading order, concept guides,
deployment limitations, and one reference page for every package.

## Packages

- `@smithers/flows` — barrel package re-exporting everything below
- `@smithers/host`
- `@smithers/journal`
- `@smithers/database`
- `@smithers/kernel`
- `@smithers/keys`
- `@smithers/engine`
- `@smithers/engine-store`
- `@smithers/sync`
- `@smithers/time-travel`

Platform host adapters (`@smithers/host-cloudflare`, `@smithers/host-vercel`) live in
[smithersai/plugins](https://github.com/smithersai/plugins).

The `@smithers/*` package names are retained. These packages form a closed workspace dependency set.

## Development

Install dependencies and typecheck every package:

```sh
npm install
npm run check
```
