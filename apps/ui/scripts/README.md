# apps/ui/scripts

E2E and live-check scripts. Run everything below from `apps/ui`.

## Launch checklist (`launch-checklist.ts`)

Headless, one-command re-run of the signed-in launch checklist (§A-F) that
produced `apps/reports/launch-checklist/*`. No origin is hardcoded — the
target is always explicit, via `--target`/`-t` or `$CHECKLIST_TARGET`.

### Post-deploy re-run

Right after a deploy, point it at the deployed origin:

```sh
cd apps/ui
CHECKLIST_SESSION_COOKIE='smithers_session=<cookie value>' \
CHECKLIST_ZERO_BALANCE_BEARER='smithers_session=<zero-balance test account cookie>' \
pnpm run checklist -- --target https://canary.smithers.sh
```

or with the flag instead of `$CHECKLIST_TARGET`:

```sh
pnpm run checklist -- --target <origin>
```

The two `CHECKLIST_*` cookie env vars are auth material — a signed-in
session's cookie header and a second session already parked at a $0 balance.
Get these from a real browser session (e.g. `launch-mint-session.ts`'s
storage-state output, formatted as `name=value; name2=value2`); never commit
them. Rows whose required env var is missing report `not-testable-yet`
instead of failing — the run still completes and still writes a report.

This runner directly executes only the checklist rows that are pure HTTP
calls against the product Worker's client-facing seams (currently D-1, D-2,
D-4 — the billing-balance rows). Rows that need a real signed-in browser
(§A, §B, §C, §F) or the billing upstream's admin surface directly (§E) are
enumerated and reported `not-testable-yet`, pointing at the dedicated script
that covers them instead (`live-signed-in-check.ts`, `live-workflow-check.ts`,
`canary-seam-probe.ts`). Run those separately for full §A/§B/§C/§F/§E
coverage; this runner is the fast, scriptable HTTP-only slice plus the
enumeration/report-skeleton contract the whole checklist shares.

### Dry run (no target needed)

Proves the row catalog, CLI wiring, and report writer all work without
touching any origin — zero network calls:

```sh
cd apps/ui
pnpm run checklist -- --dry-run
```

### Local mode

Point `--target` at a local/dev origin instead of canary. The HTTP-only rows
(D-1, D-2, D-4) actually run against it; if nothing answers, that reports an
honest `fail` per row (connection refused) rather than crashing the run —
this is how the runner proves it "wires up" without needing the live
deployment.

### Output

Every run (dry, local, or live) writes `launch-checklist-report.json` and
`launch-checklist-report.md` under `apps/reports/launch-checklist/<timestamp>Z-<dry-run|run>/`
(override with `--out <dir>`), matching the historical `launch-checklist-report.*`
shape (`generatedAt`, `target`, `totals`, `rows[]`). Exit code is `1` if any
row's status is `fail`, `0` otherwise (a dry run, or a run made entirely of
`not-testable-yet`/`pass` rows, never fails the command).

## Other scripts

- `stub-backends.ts` — test doubles for identity/billing/gateway, used by `test:e2e:worker`.
- `web-chat-e2e.ts`, `web-chat-context-e2e.ts`, `web-chat-shell-e2e.ts` — `bun test:e2e:web*`.
- `worker-e2e.ts` — `bun test:e2e:worker`, drives the product Worker against the stub backends.
- `live-check.ts`, `live-signed-in-check.ts`, `live-workflow-check.ts`, `canary-seam-probe.ts`, `launch-seam-probe.ts` — browser-driven and HTTP live checks against a real deployment (see each file's header comment for invocation and required env/profile).
- `live-store-reset.ts` — shared helper: clears a page's persisted store (OPFS/localStorage) over CDP, keeping cookies.
- `launch-mint-session.ts` — mints a Playwright storage-state file for the live checks.
