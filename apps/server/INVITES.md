# Invite mechanics

The closed-alpha allowlist gates `/api/agent/turn` and every other seam
`requireTurnSession` protects (`src/index.ts`). There are two doors onto it:

1. **Self-serve request, admin approval** — a signed-in user runs
   `auth.request-access` (`POST /api/identity/request-access`, proxied to the
   identity worker); an admin reads the queue with `admin.requests`
   (`GET /api/admin/requests`) and approves with `admin.queue.approve <login>`,
   which is exactly `POST /api/admin/allowlist { login, action: "add" }`
   issued through the product Worker with an admin session cookie.
2. **Batch seed** — `scripts/seed-allowlist.mjs`, below. For inviting a list of
   people at alpha launch, or backfilling design partners, this is the
   one-command door: it skips the UI and the per-login admin session entirely
   and talks straight to the identity worker's admin endpoint with the
   identity admin credential.

Both doors land on the same call: `POST <IDENTITY_UPSTREAM_URL>/api/identity/admin/allowlist`
with `{ login, action, requester, timestamp }` and the `x-smithers-admin-token`
header. `src/invite-mechanics.test.ts` covers door 1 end to end (request ->
approve -> the same session then passes the gate) against a stateful fake of
the identity worker; `src/seed-allowlist.test.ts` covers door 2 the same way.

## One-command seed procedure

```sh
IDENTITY_UPSTREAM_URL=https://smithers-cloud-identity.willcory10.workers.dev \
IDENTITY_ADMIN_TOKEN=<identity's ADMIN_SERVICE_TOKEN> \
pnpm --filter smithers-server run seed:allowlist -- --logins alice,bob,carol
```

or from a file (one GitHub login per line; blank lines and `#` comments are
skipped):

```sh
pnpm --filter smithers-server run seed:allowlist -- --file invitees.txt
```

Preview first with `--dry-run` — it needs no credentials and makes no network
call:

```sh
pnpm --filter smithers-server run seed:allowlist -- --file invitees.txt --dry-run
```

`IDENTITY_UPSTREAM_URL` is the same value as the `vars` entry in
`wrangler.jsonc`; `IDENTITY_ADMIN_TOKEN` is identity's `ADMIN_SERVICE_TOKEN`, a
Cloudflare secret on that deployment, not a var here — get it from wherever
that secret is held, never from this repo. `--action remove` revokes instead
of adds. `--requester <login>` sets the audit attribution (defaults to
`seed-allowlist-script`). Full flag list: `node scripts/seed-allowlist.mjs --help`.
