# Contributing

Use Node.js 22.19 or later. Install dependencies with `npm install`.

Before opening a pull request, run every gate:

```sh
npm run check
npm test
npm run lint
npm run circular
npm run browser
npm run test:examples
npx vocs build
```

Packages under `packages/` follow the structure and conventions in the Effect repository. Use `reference/effect` as the local reference when adding or changing package modules, public APIs, tests, build configuration, or package metadata.

The full contributor guide is [docs/pages/contributing.md](docs/pages/contributing.md), served at `/contributing` by `npx vocs dev`. It covers what each gate proves, the prose rules for docs pages, the commit conventions including the `Docs:` and `Depends-on:` trailers, and the epic plan.
