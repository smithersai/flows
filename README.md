# Smithers Flows

Smithers Flows is a standalone Effect-based durable-execution engine. It provides typed flows,
journal-backed execution state, content-addressed activities, capability-checked host effects, synchronization, and
time-travel protocols.

## Documentation

Start with the [documentation index](docs/README.md). It includes a recommended reading order, concept guides,
deployment limitations, and one reference page for every package.

## Packages

- `@smthrs/flows` — barrel package re-exporting everything below
- `@smthrs/host`
- `@smthrs/journal`
- `@smthrs/database`
- `@smthrs/kernel`
- `@smthrs/keys`
- `@smthrs/engine`
- `@smthrs/engine-store`
- `@smthrs/plugin`
- `@smthrs/sync`
- `@smthrs/time-travel`

Platform host adapters (`@smthrs/host-cloudflare`, `@smthrs/host-vercel`) live in
[smithersai/plugins](https://github.com/smithersai/plugins).

The `@smthrs/*` package names are retained. These packages form a closed workspace dependency set.

## Browser support

Browser support is a hard requirement, met through layers: a package root exports contracts, and every
platform implementation lives under a `/node`, `/bun`, `/browser`, or `/test` subpath. Ten entry points
bundle for the browser — `@smthrs/host`, `@smthrs/host/browser/BrowserHost`, `@smthrs/kernel`,
`@smthrs/keys`, `@smthrs/database`, `@smthrs/journal`, `@smthrs/engine`, `@smthrs/plugin`,
`@smthrs/sync`, and `@smthrs/time-travel`.

Two are Node-only and say so: `@smthrs/engine-store` (it reads `process.pid` and `node:crypto`,
issue #114) and therefore the `@smthrs/flows` barrel that re-exports it. **Browser consumers import the
per-package roots, not the barrel.**

`npm run browser` proves both halves — it bundles every browser entry point with
`platform: "browser"` and fails if one breaks, and it fails just as loudly if a Node-only entry point
starts bundling while the docs still call it Node-only. It runs as a CI step. The full matrix is
[docs/architecture/browser-support.md](docs/architecture/browser-support.md).

## Development

Install dependencies and typecheck every package:

```sh
npm install
npm run check
```
