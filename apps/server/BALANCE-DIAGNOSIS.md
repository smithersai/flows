# The $0 balance: where the zero comes from

Will, 2026-08-19, testing the closed alpha: *"it says I have $0 but I should
have a lot more than $0."*

**Verdict: production data, not code.** Nothing in `apps/ui` or `apps/server`
can produce a zero that the ledger did not answer with — that half is proved
below, at both layers, by reading the code and running the tests. The remaining
half is an INFERENCE, and is labelled as one throughout: the deployed billing
worker gates its promotional grant on an eligibility check that no account can
pass in its current configuration, so the most likely reason will's account
holds no grants is that it never received one. Fixing it is one admin grant
plus one config change; there is no code change in this repository to make, and
none was made.

**What was and was not read.** The two code layers were read directly and their
suites run. The deployed billing worker's configuration and its aggregate
metrics were read directly. Will's individual account record was NOT read: the
billing worker exposes no read-only per-account route, and the one call that
would resolve his account CREATES it as a side effect, which is a production
write this diagnosis would not make. Every statement about his specific ledger
row is therefore an inference from mechanism plus aggregates, and
["Which record is wrong — an inference, not a reading"](#which-record-is-wrong--an-inference-not-a-reading)
enumerates the alternatives that inference does not exclude.

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

### Which record is wrong — an inference, not a reading

The most likely wrong record is the account keyed by the normalized (trimmed,
lowercased) GitHub login will signs in as, in the `ACCOUNTS` Durable Object
namespace of the `smithers-cloud-billing` Worker: it holds zero grants in its
`ledger` record, and its stored `account` record carries
`eligibility: {eligible: false, policy: "allowlist", reason: "not_allowlisted"}`.

**That record was not read.** What supports it is the mechanism (the only
automatic funding path is gated on a stored eligibility verdict, and the
deployed policy cannot produce a passing one), the aggregate ledger state (three
accounts, two of them the documented canary/test logins that hold the whole
$1046), and the wire answer itself (`state: "empty"`, `totalUsd: "0"`). Current
configuration and deployment-wide totals cannot prove the FROZEN eligibility
value stored on an account that already existed, so the stored `reason` above is
the expected value, not an observed one.

Alternatives this evidence does not exclude, each of which also produces a $0
answer and each of which the remediation below still repairs:

| Alternative | Why the evidence does not exclude it |
| --- | --- |
| Will's account was created while an earlier, different `ALPHA_ELIGIBILITY_POLICY`/allowlist was deployed, so its stored `eligibility` says something else and the promo was skipped for a different reason. | Only the CURRENT configuration was read. Wrangler config history was not. |
| Will's account is the third account and was funded, then fully consumed. | Ruled out only in aggregate: `consumed_usd_total` is $0.002675 and `expired_usd_total` is $0 deployment-wide, which is too small to have drained a grant. This is strong, not conclusive, since it assumes the two documented $500 grants are the two funded accounts. |
| Will signs in under a login that normalizes to something other than the one assumed here, so the account read is a different (fresh, empty) account than any that was ever granted. | The exact normalized login was never read; step 1 of the remediation is to read it precisely because of this. |
| The account holds a grant with an `expiresAt` in the past. | `expired_usd_total` is 0, which argues against it, but expiry accounting was read only in aggregate. |

Reading the record itself needs will's session cookie (`GET
/api/billing/balance` as him, which resolves his real account), or an operator
running an admin diagnostic that accepts the account-creating side effect.
Either one turns the inference above into a reading; neither was available to
this diagnosis.

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
the aggregate ledger state; will's individual grant row was not read, and every
claim about it above is labelled an inference for that reason. Doing so
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
