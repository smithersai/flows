# Human tasks: first engine-group alpha publish

The production-readiness panel passed. Complete these owner-only tasks before
the first publish.

## H1. Verify npm control and reserve the engine names

Verify that the publishing identity controls `@smthrs`:

```sh
npm org ls smthrs
```

Reserve or confirm every engine-group name below. All returned E404 at
the audit; recheck each name before publishing:

```sh
npm view @smthrs/canonical name
npm view @smthrs/capability name
npm view @smthrs/crypto name
npm view @smthrs/artifacts name
npm view @smthrs/database name
npm view @smthrs/jj name
npm view @smthrs/journal name
npm view @smthrs/keys name
npm view @smthrs/observability name
npm view @smthrs/plan name
npm view @smthrs/flow name
npm view @smthrs/engine name
npm view @smthrs/run-store name
npm view @smthrs/step-cache name
npm view @smthrs/sync name
npm view @smthrs/kernel name
npm view @smthrs/engine-store name
npm view @smthrs/platform-browser name
npm view @smthrs/platform-bun name
npm view @smthrs/platform-node name
npm view @smthrs/sandbox name
npm view @smthrs/time-travel name
npm view @smthrs/flows name
```

## H2. Confirm the LICENSE copyright holder — DONE

Confirmed by the owner on 2026-08-17: MIT, with `LICENSE:3` reading
`Copyright (c) 2026 William Cory and the Smithers Flows contributors`, accepted
as final. Every engine manifest already declares `"license": "MIT"`. This closes
the `REVIEW.md` blocker 5 caveat. A published version is immutable, so changing
the holder after the first publish requires a new version.

## H3. Run the first actual publish

Push the real `v0.1.0-next.0` tag and run `release.yml` for the first actual
publish. Follow the [release runbook](docs/release-runbook.md) exactly.

## H4. Give final alpha-shippable sign-off

Confirm that the engine group is alpha-shippable, using the
[alpha notes](docs/alpha-notes.md), [release rehearsal](docs/release-rehearsal.md),
and the production-readiness panel's passing verdicts recorded in this run.
