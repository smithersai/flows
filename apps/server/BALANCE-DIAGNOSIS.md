# The $0 balance: where the zero comes from

Will, 2026-08-19, testing the closed alpha: *"it says I have $0 but I should
have a lot more than $0."*

**Verdict: production data, not code.** Nothing in `apps/ui` or `apps/server`
can produce a zero that the ledger did not answer with. Will's billing account
holds no grants, because the deployed billing worker's promotional grant is
gated on an eligibility check that no account can pass in its current
configuration. Fixing it is one admin grant plus one config change; there is
no code change in this repository to make, and none was made.

Verified 2026-08-19 against the deployed stack.

## What a $0 chip actually means

The corner balance chip is not a best-effort render. The balance parse
(`apps/ui/src/mainview/state/controller/auth-billing.ts`) dispatches
`billing.unavailable` on a fetch throw, a non-ok response, unparseable JSON, a
`state` outside `ok | low | empty`, a non-boolean `allowedToStartWork`, or a
non-string `balance.totalUsd`. Only a well-formed body reaches
`billing.refreshed`, and `App.tsx` renders `Balance unavailable` for the
unavailable state, nothing at all while the state is `unknown`, and a dollar
figure only otherwise.

So `$0` is not a fallback. It means `GET /api/billing/balance` genuinely
answered `{state: "empty", allowedToStartWork: false, balance: {totalUsd: "0"}}`
for will's account.

## Layer 1 — `apps/ui`: ruled out

The honest-states contract is pinned by
`src/mainview/state/ZeroBalanceLaunch.test.ts`, `Backends.test.ts`,
`AuthChat.test.tsx` and `Admin.test.ts`. This diagnosis changed none of it.

## Layer 2 — `apps/server`: ruled out, and now pinned

`/api/billing/*` is served by `proxyToBilling` (`src/index.ts`). It holds no
ledger, no grant lookup and no cents/dollars conversion; unconfigured it
answers an honest 501 rather than a zero. It strips client-injected identity
headers, validates the session against the identity worker, then forwards
`x-smithers-service-token` plus `x-user-login: session.login`.

Two questions the brief raises, both answered here:

- **Login vs id.** Identity normalizes the login before this Worker sees it,
  and billing's `authenticateTrusted` applies the same normalization, so the
  read key and the grant key agree. `x-user-id` and `x-user-login` are set from
  the same `session.login`.
- **A unit mixup.** There is none: the balance body is forwarded verbatim.

Both are now regression-tested at this layer, in the `billing seam` describe of
`src/index.test.ts`:

- *passes the billing answer through untouched — no unit conversion, no
  zeroing* — an `empty` body and a funded `$500.00` body each arrive at the
  client byte for byte.
- *keys the account by the identity-validated login, identically on both
  headers* — identity's answer is forwarded verbatim on `x-user-login` and
  `x-user-id`, and a client-supplied login does not survive the strip.

`seed-allowlist.mjs` writes only the identity allowlist and grants no money.
The invite mechanics carry no billing step at all.

## Layer 3 — the fault: `smithers-cloud-billing`, upstream, in production data

Source `~/flows/ui/workers/billing` (`apps/UPSTREAMS.md`), domain
`billing.smithers.sh`. Deployed version `880ae457-dd96-42f7-b390-cb46f3c4ef0e`
from git sha `2b111890`, receipt `2026-08-19T19:04:34Z`.

A balance is a list of dollar grants in the account's Durable Object
(binding `ACCOUNTS`, class `AccountDurableObject`, key `ledger`). Nothing else
creates money. The only automatic funding is the promotional grant in
`ensure()` (`src/account.ts`), gated on `account.eligibility.eligible`.

At the deployed sha, `wrangler.jsonc` sets:

```jsonc
"ALPHA_ELIGIBILITY_POLICY": "allowlist",
"ALPHA_GITHUB_ALLOWLIST": "",
"PROMO_GRANT_USD": "100",
```

`evaluateEligibility` (`src/balance.ts`) matches the login against that empty
array, so it returns `{eligible: false, policy: "allowlist", reason:
"not_allowlisted"}` for **every** user. No account can self-fund. A fresh
account's ledger is empty, and `summary.totalNanos <= 0` summarizes to exactly
`state: "empty"`, `totalUsd: "0"`, `allowedToStartWork: false` — the wire
answer will is seeing.

### The wrong record, precisely

The account keyed by the normalized (trimmed, lowercased) GitHub login will
signs in as, in the `ACCOUNTS` Durable Object namespace of the
`smithers-cloud-billing` Worker, holds **zero grants** in its `ledger` record.
Its stored `account` record carries
`eligibility: {eligible: false, policy: "allowlist", reason: "not_allowlisted"}`.

### Two details that change the remediation

1. **Eligibility is evaluated once, at account creation, and stored**
   (`src/account.ts`); the promo branch reads that frozen verdict. Will's
   account already exists, so populating `ALPHA_GITHUB_ALLOWLIST` now would
   **not** retroactively fund it. A config fix alone cannot repair his balance.
2. **The identity allowlist that gets a person into the closed alpha is a
   different list in a different Worker.** Being allowlisted for access confers
   no balance, which is why an onboarded user lands at $0 with everything else
   working.

### Evidence (read-only GETs, no credentials, no writes)

`GET https://billing.smithers.sh/healthz`:

```json
{"ok":true,"stripe":false,"metering":true,"adminGrants":true,"productBridge":true,
 "accountingSerializable":true,"ratesConfigured":true,"rateCardVersion":"2026-08-09.1"}
```

The trusted-caller bridge is live, so the balance read really did resolve an
account rather than fail.

`GET https://billing.smithers.sh/metrics`:

| Metric | Value |
| --- | --- |
| `smithers_billing_accounts_total` | 3 |
| `smithers_billing_granted_usd_total{kind="promotional"}` | 1046 |
| `smithers_billing_granted_usd_total{kind="purchased"}` | 0 |
| `smithers_billing_consumed_usd_total{kind="promotional"}` | 0.002675 |
| `smithers_billing_expired_usd_total` | 0 |
| `smithers_billing_denials_total{reason="insufficient_balance"}` | 1 |

Three billing accounts exist deployment-wide, and this repo's receipts name the
two funded ones: `smithers-canary` $500 via grant
`admin:2026-08-09:wave7-canary-subsidy` (`apps/WAVE7-DEPLOY-RECEIPT.md`) and
`codeplanesmithers` $500 via `admin:2026-08-10:codeplanesmithers-launch`
(`apps/WAVE13-RECEIPT.md`). That is $1000 of the $1046; the remainder is
consistent with the launch checklist's own $1.00 E-3 grants. Both funded logins
are test/canary identities. The third account — the login will actually signs
in as — carries no grant, which is also what the single `insufficient_balance`
denial records. Nothing has expired, so this is a never-granted balance, not a
lapsed one.

### Limit of the evidence, stated plainly

Billing exposes no read-only per-account admin route — its whole route set is
`/healthz`, `/metrics`, `/webhooks/stripe`, `POST /api/billing/admin/grants`,
and the authenticated `/api/billing/*` paths — and the store is Durable Objects
rather than SQL, so there is no query to run against it. Probing a specific
login through the trusted-caller balance read was deliberately **not** done:
that call runs `ensureAccount`, which CREATES the account and increments
`accounts_total`. It is a production write, and production inspection here is
read-only. What is confirmed is the mechanism, the deployed configuration and
the aggregate ledger state; will's individual grant row was not read. Doing so
requires his session cookie, or an admin who accepts the account-creating side
effect.

## Remediation (for a human to apply; nothing here was applied)

1. Read `GET /api/auth/session` to get the exact normalized login.
2. As an admin, run `/admin.grant 500 <login>` in the app and confirm the card
   it renders. That POSTs `/api/admin/grant` (admin-session gated in
   `apps/server/src/index.ts`), which forwards to billing
   `POST /api/billing/admin/grants` as `{userId: <login>, grantId:
   "admin:product-…", amountUsd: 500, kind: "promotional", requester,
   timestamp}`. The cap is `MAX_ADMIN_GRANT_USD = 10000`; with no `expiresAt`
   the grant is non-expiring, and it is credited exactly once (idempotent by
   `grantId`).
3. Re-read the balance chip, or run `/billing.balance`, and re-run launch
   checklist row **D-1** — the row that asserts `state === "ok" &&
   allowedToStartWork === true` for a signed-in session, and the live detector
   for this class of defect.

Separately, so the next alpha user does not repeat this: set
`ALPHA_GITHUB_ALLOWLIST` (or `ALPHA_ELIGIBILITY_POLICY: "open"`) on the billing
worker and redeploy. Per detail (1) above that funds only accounts created
**after** the change, so everyone already onboarded still needs an explicit
grant.
