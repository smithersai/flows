# Contributing

Use Node.js 22.19 or later. Install dependencies with `pnpm install`.

Before opening a pull request, run every contract gate:

```sh
pnpm run check
pnpm test
pnpm run lint
pnpm run circular
pnpm run browser
pnpm exec smthrs lint '//:ci'
node --test scripts/pack-release.test.mjs
node --test scripts/release-rehearsal.test.mjs
node --test scripts/set-release-version.test.mjs
node --test scripts/flows-backup.test.mjs
node --test scripts/check-test-pins.test.mjs
```

These are contract gates: [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs every one of them, and `//:ci` is the declaration that says so. `pnpm exec smthrs lint '//:ci'` reads the checked-in workflow and fails when a declared gate or a required job is gone, so deleting a gate step from `ci.yml` fails this list rather than silently shrinking it.

Two commands that used to appear above are local-only, and no workflow runs either:

- `pnpm run test:examples` filters `@smthrs/examples`, whose `test` script `pnpm test` already runs recursively. It is a shortcut for iterating on that one workspace, not a separate gate.
- `pnpm exec vocs build` builds the documentation site. `ci.yml` gates documentation content through `pnpm exec smthrs docs '//...'`, and the site itself is deployed from [`apps-deploy.yml`](.github/workflows/apps-deploy.yml). Run it locally when you change `docs/pages/`.

The gates above cover the `test` job. `ci.yml` also runs Rust, WebAssembly reproducibility, bun, and browser lanes, each of which needs a toolchain this list does not assume; `//:ci` names them in `requiredJobs`.

Packages under `packages/` follow the structure and conventions in the Effect repository. Use `reference/effect` as the local reference when adding or changing package modules, public APIs, tests, build configuration, or package metadata.

## Working with the vendored jj submodule

The Rust crates under `crates/` build against `jj-lib` from the `vendor/jj` git submodule. A plain `git clone` leaves that directory empty and `cargo` then fails with a missing `vendor/jj/lib/Cargo.toml`. Populate it once after cloning:

```sh
git submodule update --init
```

Run the same command after any pull that moves the submodule pointer. Only the Rust and WebAssembly work reads `vendor/jj`; the TypeScript gates do not.

## JSDoc convention

`pnpm run lint` enforces this. The rules live in [`eslint.jsdoc.js`](eslint.jsdoc.js), which every package's `eslint.config.js` spreads in.

- **Every module gets a header** — a block above the first statement, carrying prose and `@since`. It says what the module is for and why it is shaped the way it is, not what its exports are called.
- **Every exported declaration gets prose, `@category`, and `@since`.** The prose must let a reader learn what the thing IS and when to reach for it without opening the implementation. `packages/flow/src/RetryPolicy.ts` is the bar; `packages/kernel/src/GrantStore.ts` is the canonical service-module shape and `packages/engine-store/src/internal/AttemptProbe.ts` the internal-module one.
- **One tag per line.** `@since 0.1.0 @category models` on a single line parses as one `@since` tag whose description happens to contain the word `@category`, so the second tag silently does not exist.
- **`@category` is a lowercase noun** — `models`, `constructors`, `layers`, `services`, `errors`, `schemas`, and the few narrower ones a module already uses.
- **`@since` is `0.1.0`** for new code; nothing here has shipped. Code adapted from Effect v4 keeps the `4.0.0` it was written with, because that is the release it dates from.
- **`@private` blocks drop `@category`** and need no prose — a private export belongs to no documented category. They still carry `@since`.
- **There is no `@internal` tag.** Hiding a module is done three other ways, all of which survive a reader who ignores comments: put it under `internal/`, null its entry in the package `exports` map, and mark the declaration `@private`.
- **Re-exports are not gated.** `export { x }` and `export * as Ns from "…"` document the module they point at; their prose belongs at the definition site.

The full contributor guide is [docs/pages/contributing.md](docs/pages/contributing.md), served at `/contributing` by `pnpm exec vocs dev`. It covers what each gate proves, the prose rules for docs pages, the commit conventions including the `Docs:` and `Depends-on:` trailers, and the epic plan.
