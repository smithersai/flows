# Contributing

Use Node.js 22.19 or later. Install dependencies with `npm install`.

Before opening a pull request, run:

```sh
npm run check
npm test
npm run lint
npm run circular
```

Packages under `packages/` follow the structure and conventions in the Effect repository. Use `reference/effect` as the local reference when adding or changing package modules, public APIs, tests, build configuration, or package metadata.
