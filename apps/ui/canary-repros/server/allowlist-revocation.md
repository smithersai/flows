# allowlist-revocation — removing a login from the allowlist revokes nothing

Origin: <https://canary.smithers.sh> (Worker `smithers-mvp-web`, version
`e84ad45e-0311-4eed-b326-dc0bc80aeec9`) · Upstreams: `smithers-cloud-identity`,
`smithers-cloud-reco` · Account: `codeplanesmithers` (allowlisted, admin via
identity's `ADMIN_LOGINS`) · Tested: 2026-08-19, server lane round 3.

Checklist row: **1.5** — the server half. The UI half is in `../access/1.5.md`.

## The chain

1. `workers/identity/src/index.ts` `sessionAnswer()` read the `admin` claim off
   the `ADMIN_LOGINS` var alone, so a de-allowlisted login came back
   `allowlisted: false, admin: true` from BOTH session doors
   (`GET /api/auth/session` and `POST /api/identity/validate`).
2. `apps/server/src/index.ts` `handleAdmin()` gated on `session.admin` only, so
   that session kept every `/api/admin/*` route — including
   `POST /api/admin/allowlist`, the door that edits the allowlist itself.
3. `workers/recommendations/src/index.ts` `requireSession()` never read
   `allowlisted` at all, so `GET /api/reco/first-run` served a de-allowlisted
   account the full non-degraded digest — watched repositories, issue and
   pull-request counts and all. Measured in `../access/1.5.md`:
   `{"degraded":false,"cached":true,"watched":[…3 repos…],"digest":{…}}`.

So de-allowlisting a compromised admin revoked nothing at any seam.

## The one-way door the fix creates, and what it costs

Once being allowlisted is what carries admin, a self-removal revokes the
caller's own claim — and `POST /api/admin/allowlist` is the only door that could
put it back. The first admin to try it would lock the closed alpha out of its
own product, with the operator's `ADMIN_SERVICE_TOKEN` as the only route back.
`../access/1.5.ts` does exactly that removal and restores in a `finally`, so
without a guard the fix would turn that repro into a lockout.

So the product refuses a self-removal outright, with a 409 that names the route
that does work. That refusal is what this repro drives: it is the one clause of
the chain a single test login can observe live without risking the account.

## Steps

1. Sign in on <https://canary.smithers.sh> as an allowlisted admin.
2. `POST /api/admin/allowlist {"login":"codeplanesmithers","action":"remove"}` —
   the caller's own login.
3. Read `GET /api/auth/session` and `GET /api/admin/health`.

## Expected

The self-removal is refused with `409` and a message naming why and what to do
instead. The session's standing is unchanged and the admin surface still
answers.

## Actual

```
session: {"login":"codeplanesmithers","allowlisted":true,"admin":true,"scopes":["read:user"]}
POST /api/admin/allowlist {"login":"codeplanesmithers","action":"remove"} -> 201 {"applied":true,"action":"remove","login":"codeplanesmithers",…}
emergency restore: 201 {"applied":true,"action":"add",…}
session after: {"login":"codeplanesmithers","allowlisted":true,"admin":true,"scopes":["read:user"]}
GET /api/admin/health -> 200
FAIL: an admin removed its OWN login from the allowlist (HTTP 201) — the one write that revokes the door that could undo it
```

The removal lands. (The session still reads `admin: true` afterwards only
because clause 1 is the bug: on the deployed build the allowlist does not carry
admin, which is why the restore still worked. This repro restores immediately
either way and leaves the allowlist as it found it.)

## Honest limit of this repro

The cross-account clauses — a DIFFERENT login's session going
`allowlisted:false -> admin:false`, its `/api/admin/*` going to the canonical
404, its `/api/reco/first-run` going to 403 — need a second GitHub account, the
gap checklist §0.4 already names. They are not asserted here. They are covered
by unit tests that fail before the fix and pass after:

- `apps/server/src/invite-mechanics.test.ts` — "removing an admin from the
  allowlist revokes the admin surface, editor first", "an admin cannot remove
  its own login, and the refusal names the route that works"
- `apps/server/src/index.test.ts` — "a de-allowlisted admin is as undetectable
  as a stranger"
- `~/flows/ui/workers/identity/src/index.test.ts` — "withholds admin from an
  ADMIN_LOGINS login that is not allowlisted, on both session doors",
  "de-allowlisting an admin revokes admin on the next read — no re-login"
- `~/flows/ui/workers/recommendations/src/index.test.ts` — "refuses every cookie
  route for a signed-in login that is not allowlisted"

## Routes and sources

- `POST /api/admin/allowlist`, `GET /api/auth/session`, `GET /api/admin/health`,
  `GET /api/reco/first-run` on `smithers-mvp-web`.
- `apps/server/src/index.ts` (`handleAdmin`),
  `~/flows/ui/workers/identity/src/index.ts` (`sessionAnswer`),
  `~/flows/ui/workers/recommendations/src/index.ts` (`requireSession`).

## Repro output (before the fix, against the deployed Worker)

Quoted in full under **Actual** above; `bun canary-repros/server/allowlist-revocation.ts`
exits 1.

The fix is committed but NOT deployed — this run does not deploy (the serial
deploy stage after it does), and the reco and identity Workers need their own
deploys from `~/flows/ui`. Re-run this repro after those; it exits 0.

## Screenshot

None — every clause is a seam call, and the answers are quoted above.
