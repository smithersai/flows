# `auth` probe fails on every smithers-backend-canary-cheap run

- **Lane:** plue-deploy
- **Target:** `https://api.jjhub.tech` (the API `https://canary.smithers.sh` talks to)
- **Workload:** CronJob `smithers-backend-canary-cheap` in namespace `smithers` (GKE `plue-cluster`)
- **Repro script:** `backend-canary-auth.ts` (run `bun install` first, then `bun backend-canary-auth.ts`)

## Steps

1. `kubectl logs -n smithers <smithers-backend-canary-cheap pod> --tail=60`
2. Observe 17 probes PASS and one FAIL.
3. Run `bun backend-canary-auth.ts` to isolate the cause without touching prod data.

## Expected

All 18 cheap-tier probes pass, so the CronJob pod exits 0 and the status page
reports `components.canary.status` as `ok`.

## Actual

```
[canary] FAIL auth (0.5s) — POST /auth/key/verify returned 401: {"message":"invalid signature"}
...
[canary] PASS sse (15.0s)
[canary] reported 18 result(s) to suite "workflow"
[canary] failure notification failed: warn: failure notification returned 401
error: 1 of 18 canary probe(s) failed: auth
```

Every pod since at least 2026-08-19 01:35 UTC ends `0/1 Error` for this reason.

## Root cause (two stacked defects)

### 1. The canary signed the wrong EIP-4361 domain — FIXED

`.smithers/workflows/canary-runner.ts` built the signed message from
`new URL(ctx.apiBase).host`, i.e. `api.jjhub.tech`. `internal/auth/key_auth.go`
requires both the signed `domain` line and the signed `URI:` host to equal
`auth.key_auth_domain`, which `internal/config/config.go` defaults to
`smithers.sh` and which the `smithers-api` Deployment does not override
(`SMITHERS_AUTH_KEY_AUTH_DOMAIN` is unset among its 68 env vars). Domain
mismatch is reported to the client as `401 {"message":"invalid signature"}`.

Repro output (throwaway key, deliberately invalid nonce, so nothing is created):

```
domain=api.jjhub.tech -> 401 {"message":"invalid signature"}
domain=smithers.sh    -> 401 {"message":"invalid or expired nonce"}

BUG PRESENT: the API accepts signatures over "smithers.sh" but the canary signs "api.jjhub.tech".
```

`domain=smithers.sh` getting as far as the nonce check proves the signature
itself verifies; only the domain binding differed.

Fixed in `~/plue` commit `11c279fa` — the probe signs the configured sign-in
domain, overridable with `CANARY_KEY_AUTH_DOMAIN`.

### 2. The canary wallet has no closed-alpha access — BLOCKED ON A HUMAN

With the domain fixed, the probe run against production returns:

```
[canary] FAIL auth (0.3s) — POST /auth/key/verify returned 403: {"message":"closed alpha access requires a whitelist invite"}
```

The canary's key-auth wallet is `0xBE00A86AD1490C7d78C12f8DdA3AD2eA3E75364f`.
It has no row in `users.wallet_address` and no row in
`alpha_whitelist_entries`. That table holds 5 entries seeded 2026-06-28 through
2026-08-04 — `username smithers-canary`, `email canary@smithers.sh`,
`email will@smithers.sh`, `username codeplanesmithers`, `username roninjin10` —
and no `wallet` identity at all. `AuthService.VerifyKeyAuth` checks the
**wallet** identity for a first-time signer, so the seed misses the identity the
key-auth path actually enforces.

**What the human must do:** with an admin token,

```
POST https://api.jjhub.tech/api/admin/alpha/whitelist
{"identity_type":"wallet","identity_value":"0xBE00A86AD1490C7d78C12f8DdA3AD2eA3E75364f"}
```

`CANARY_API_TOKEN` is not an admin token (that call returns
`403 {"message":"admin access required"}`), so this cannot be done from the
canary's own credentials. Granting closed-alpha access is an authorization
decision, so it was not applied by writing to the production database directly.

## Blast radius

`https://status.jjhub.tech/api/status` reports
`"canary":{"status":"error","detail":"one or more canary tests failing","failing_tests":2,"total_tests":30}`.
The second failing test is the Playwright canary's
`ui-canary-pipeline reports live canary health rather than 'unknown'`, which
asserts that same field is `ok|degraded|disabled`. Both reds collapse into this
one root cause.
