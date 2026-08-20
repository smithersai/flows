# oauth-cancel-copy — cancelling GitHub's consent screen is blamed on the sign-in service

Origin: <https://canary.smithers.sh> (Worker `smithers-mvp-web`, version
`e84ad45e-0311-4eed-b326-dc0bc80aeec9`) · Tested: 2026-08-19, server lane
round 3.

Checklist row: **2.3** — the residual copy defect recorded at the top of
`../access/2.3.md` after the origin half of that row was closed.

## Steps

1. Load
   `https://canary.smithers.sh/api/auth/github/callback?error=access_denied&error_description=The+user+has+denied+your+application+access.&state=repro-server-lane`
   — the exact shape GitHub sends when the user presses **Cancel** on the
   consent screen. (Driving the URL directly means no authorization has to be
   revoked, so the repro leaves the account untouched.)
2. Read the status and the rendered page.

## Expected

The page names what happened: the user cancelled, nothing was signed in, and
there is a way back. Nothing failed, so the status is a 200.

## Actual

```
GET /api/auth/github/callback?error=access_denied -> 400
the page says: "SMITHERS

GitHub sign-in didn't finish.

You were on your way back from GitHub, but the sign-in service answered HTTP 400, so the sign-in could not complete. Nothing was signed in — head back and try again.

Back to Smithers"
```

Four things are wrong and one is right. The link back works. But the page
blames "the sign-in service", quotes an HTTP status at a user for their own
decision, never says the sign-in was cancelled, and answers 400 for a request
that did exactly what it was told.

## Root cause

`handleAuthNavigation` in `apps/server/src/index.ts` forwarded the callback to
the identity worker no matter what it carried. `error=access_denied` carries no
`code`, so identity answered its own `400 {"message":"code and state are
required"}` and the generic non-2xx branch rendered the "the sign-in service
answered HTTP 400" page. The real cause was in the query string the whole time.

## Fix

`oauthCallbackRefusal` reads the callback's `error` before any upstream call:
`access_denied` renders a 200 "You cancelled the GitHub sign-in." page, and any
other documented OAuth error keeps a 400 while naming what GitHub called it and
what GitHub said about it. Regression tests in `apps/server/src/index.test.ts`:
"a cancelled consent screen is named as a cancellation, not an upstream
failure", "any other OAuth error names what GitHub called it, and keeps a 400",
and "a cancelled callback answers JSON callers a cancellation too" (the last one
also pins that the upstream is never called).

## Route and selector

- Route: `GET /api/auth/github/callback?error=…` on `smithers-mvp-web`.
- Selector: the rendered page body, and `a[href="/"]` for the way back.

## Repro output (before the fix, against the deployed Worker)

```
$ bun canary-repros/server/oauth-cancel-copy.ts
GET /api/auth/github/callback?error=access_denied -> 400
the page says: "SMITHERS\n\nGitHub sign-in didn't finish.\n\nYou were on your way back from GitHub, but the sign-in service answered HTTP 400, so the sign-in could not complete. Nothing was signed in — head back and try again.\n\nBack to Smithers"
FAIL: the page blames the sign-in service for a cancellation: …
FAIL: the page shows the reader an HTTP status for their own decision: …
FAIL: the page never says the sign-in was cancelled: …
FAIL: a user's own cancellation answered HTTP 400; nothing failed, so it is a 200
$ echo $?
1
```

The fix is committed but NOT deployed — this run does not deploy (the serial
deploy stage after it does). Re-run this repro after that deploy; it exits 0.

## Screenshot

None needed — the page's own rendered text is quoted above in full.
