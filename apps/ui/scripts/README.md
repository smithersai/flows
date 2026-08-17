# apps/ui/scripts

E2E and live-check scripts. Unless a section says otherwise, run them from
`apps/ui`.

## Launch checklist (`launch-checklist.ts`)

Headless, one-command re-run of the signed-in launch checklist (§A-F) that
produced `apps/reports/launch-checklist/*`. No origin is hardcoded — the
target is always explicit, via `--target`/`-t` or `$CHECKLIST_TARGET`.

The command works from the repository root and from `apps/ui`; the root
`checklist` script forwards to this one.

### Post-deploy re-run

Right after a deploy, point it at the deployed origin:

```sh
CHECKLIST_SESSION_COOKIE='smithers_session=<cookie value>' \
CHECKLIST_ZERO_BALANCE_BEARER='smithers_session=<zero-balance test account cookie>' \
pnpm run checklist -- --target https://canary.smithers.sh
```

or with the flag instead of `$CHECKLIST_TARGET`:

```sh
pnpm run checklist -- --target <origin>
```

### What it actually checks

Every row in the catalog has a probe — nothing is enumerated but unchecked:

- The §A, §B, §C and §F rows, plus D-3 and D-4's pause half, drive a **real
  headless Chrome page** on the target over the DevTools protocol
  (`headless-page.ts`), carrying `$CHECKLIST_SESSION_COOKIE` as the session.
  They assert against the rendered document: the composer next to the
  transcript, the `[data-flows]` command manifest the app shell publishes,
  the `[data-flow]` name on each affordance, the `$500 of usage on us` line
  against the balance seam's `introUsd`, the reply to each impossible ask.
- D-1, D-2 and the §E rows are HTTP: the product Worker's billing seams and
  the billing upstream's admin surface.
- D-4 asserts **both** halves: the turn seam still answers at $0 (chat is
  complimentary), and a workflow launch on the $0 session is refused into the
  transcript with the client's zero-balance pause statement instead of
  starting a run.

No browser is downloaded or installed. The driver uses a system
Chrome/Chromium (`--browser <path>`, else `$CHECKLIST_BROWSER`, else the usual
install locations). One browser process is launched per run and one page per
distinct session cookie.

A row reports `not-testable-yet` only for a named, specific reason: a missing
auth env var, no browser on this machine (or `--no-browser`), or a fact the
target's own state does not contain — an empty watched set for A-3, no
recommendation to dismiss for A-9, no run id rendered for B-3. It is never a
blanket deferral. `live-signed-in-check.ts` and `live-workflow-check.ts`
remain the checks that drive the real OAuth redirect and launch their own
workflow runs.

### Auth material

The `CHECKLIST_*` env vars are auth material; never commit them.

| Variable | Rows | What it is |
| --- | --- | --- |
| `CHECKLIST_SESSION_COOKIE` | §A (except A-1), §B, §C, §F, D-1, D-2, D-3 | Cookie header for a normal signed-in session |
| `CHECKLIST_ZERO_BALANCE_BEARER` | D-4 | Cookie header for a session already parked at $0 |
| `CHECKLIST_BILLING_UPSTREAM_URL` | §E | Billing upstream origin |
| `CHECKLIST_BILLING_ADMIN_TOKEN` | E-2, E-3 | Billing upstream admin token |

Get the cookie headers from a real browser session (e.g.
`launch-mint-session.ts`'s storage-state output, formatted as
`name=value; name2=value2`). Rows whose required env var is missing report
`not-testable-yet` instead of failing — the run still completes and still
writes a report. A-1 is deliberately cookie-less: it is the signed-out view.

### Dry run (no target needed)

Proves the row catalog, CLI wiring, and report writer all work without
touching any origin — zero network calls and no browser:

```sh
pnpm run checklist -- --dry-run
```

### Local mode

Point `--target` at a local/dev origin instead of canary. The probes really
run against it; if nothing answers, that reports an honest `fail` per row
(connection refused) rather than crashing the run — this is how the runner
proves it "wires up" without needing the live deployment. Add `--no-browser`
to keep a local run HTTP-only.

### Where the code lives

The row catalog, the runner, and the CLI contract are under
`../src/launch-checklist/` and are covered by `bun test src`. This script is
the process shell (clock, filesystem, browser, exit code), and
`headless-page.ts` is the DevTools-protocol page driver.

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
