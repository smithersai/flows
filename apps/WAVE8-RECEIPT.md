# Wave 8 — Receipt: no dead ends on the live surface

2026-08-09 (UTC) · run `oneshot-wave8-deadend` · branch `oneshot-mskp7qe7-work` (~/mvp)

**Bottom line:** the sign-in click can no longer strand a user on raw JSON — the product Worker's auth-navigation seam renders a minimal branded page (what happened + the way home, HTTP status preserved) for browsers and keeps the machine answer for `Accept: application/json`, on both OAuth routes, for any non-redirect upstream answer. The signed-out landing boots with **zero console errors**: the expected signed-out 401 is restated by the seam as a resolved `200 { status: "signed-out" }`, and the balance read is driven by the session answer instead of a blind boot probe that could only 401. Deployed as `smithers-mvp-web` version **`f3e31d62-3f73-404c-a6ac-8313312dfb80`** and re-verified live with headless Chromium (8/8 checks, screenshots committed).

## What changed

- **`src/worker/index.ts`** — the seam, fixed once so it covers every future auth error:
  - `handleAuthNavigation` wraps `/api/auth/github/start` and `/api/auth/github/callback` (GET). Redirects pass through untouched. Any non-redirect upstream answer (503/5xx/4xx/oddity) or an unreachable upstream (502) is negotiated: browsers (`Accept` without `application/json`-only) get a self-contained branded HTML page — inline CSS on the app's paper/teal/gold tokens, no external assets, constants-only interpolation — that says honestly what happened and offers the one action (`Back to Smithers`, `/`); `Accept: application/json` callers get the upstream response verbatim. The HTTP status is preserved either way. No identity seam at all → 501 in both shapes.
  - `probeAuthSession` wraps `GET /api/auth/session`: the upstream's expected signed-out **401** becomes `200 { "status": "signed-out" }` — the browser logs any 4xx as a console error no matter how calmly client JS handles it, so the expected answer is stated as the resolved fact it is. The 401 and nothing else: the identity worker spends 403 on "Forbidden origin" (a deployment whose `ALLOWED_ORIGINS` omits this Worker — every identity call broken, nobody able to sign in), and restating *that* as signed-out would paint a broken deployment as a calm landing with a clean console. 403/5xx/unreachable pass through untouched (real failures still surface).
- **`src/shared/AgentApiRoutes.ts`** — `AUTH_CALLBACK_PATH` joins the shared route contract.
- **`src/mainview/state/AppController.ts`** — `loadSession` resolves the seam's 200 signed-out shape to the same state as a 401 (scopes copy still fetched), and fires `refreshBalance()` on sign-in. **`src/mainview/main.tsx`** drops the blind boot-time balance probe — signed out it could only 401 (the second console error). Real failures keep their honest states (`unavailable`); nothing is swallowed.
- **Tests:** 10 new worker unit tests (negotiation, both routes, redirect pass-through, unreachable upstream, no-seam 501, probe translation, 5xx pass-through); 2 new client tests (200 signed-out shape; balance read driven by the session answer). Worker e2e: stub identity gains an `oauth-down` control answering the real `503 oauth_not_configured` shape; a new section asserts the honest page (way home + status) for browsers and verbatim JSON for machines on both routes. `scripts/live-check.ts` (new): headless proof, local mode (zero console errors on the signed-out landing) and live mode (§ below).

## Proofs

**Local (this tree):** `bun test src` 187/187 · `bun run typecheck` clean · `bun scripts/worker-e2e.ts` PASS (every prior section plus the wave-8 OAuth section) · `bun scripts/live-check.ts local` PASS: landing renders, console clean.

**Live (https://canary.smithers.sh, version `f3e31d62`):** `bun scripts/live-check.ts live` — 8/8 (screenshots `reports/live-checks/2026-08-09_18-27-39/`; the first pass, against the superseded version `913d0555`, is kept at `.../2026-08-09_18-18-20/`):
- (a) landing renders the one-sentence + sign-in state with **zero console errors** (`.../landing.png`);
- (b) the sign-in click lands on github.com's authorize page (see "world changed mid-run" below); a **real failed callback** (`code/state=bogus`, upstream token exchange fails) renders the branded honest page — `HTTP 400`, "GitHub sign-in didn't finish.", the way back home (`.../signin-honest-page.png`) — and the way home returns to the landing with the console still clean;
- (c) the same failed callback with `Accept: application/json` answers `HTTP 400 application/json`.
- `bun scripts/canary-seam-probe.ts` PASS (its OAuth-start assertion updated to the seam's honest contract: github.com redirect when on, 5xx when off — never a wrong-app redirect, never raw JSON for a browser).

## The world changed mid-run (honest surprises)

1. **GitHub OAuth was switched ON at the identity upstream while this wave was in flight** (a concurrent session — healthz flipped from the wave-7 `oauth:false` to `{"oauth":true,"requestedScopes":["read:user"]}` with `redirect_uri` `https://canary.smithers.sh/api/auth/github/callback`). The original bug's 503 therefore no longer reproduces on the start route live: the click now happily redirects to GitHub. The dead-end fix is proved live on the callback route against a *real* upstream error, and on the start route by the stub e2e + unit tests. The live-check script asserts both honest states so it stays correct whether OAuth is on or off.
2. **A foreign, unvetted `wrangler.jsonc` edit appeared in the working copy mid-run** (`BILLING_UPSTREAM_URL` → workers.dev hostname, comment claiming same-zone fetches 522) from one of the concurrent sessions sharing this jj-colocated tree. It is **not** in this wave and not in the deploy: stashed as `preflight oneshot-wave8-deadend: foreign mid-run wrangler.jsonc edit …` (`git stash list`). Its premise is doubtful — wave 7 verified the billing seam through `billing.smithers.sh` live, and this wave's canary probe passes with it — but applying or reverting it is that session's call.
3. **The worker e2e was already broken at HEAD** (before any wave-8 edit): `wrangler dev` rewrites request URLs to the configured route, so the proxy stated `http://canary.smithers.sh` to the doubles and their localhost-only origin gates 403'd it; and the wave-6c/3b client-driven sections POST turns without the session cookie, which the wave-7 turn gate rightly 401s. Fixed as part of keeping the e2e green: the doubles take the Worker's presented origin as an extra allowed origin (exactly the real siblings' `ALLOWED_ORIGINS` discipline), and the client-driven sections attach the journey's cookie like a browser would.

## Review pass (post-implementation)

A review of this wave's own diff found and fixed two things before the final deploy:

1. **The signed-out restatement was too wide.** `probeAuthSession` translated 401 *and* 403. The identity worker's 403 is "Forbidden origin" only — a real, total misconfiguration — so the seam would have reported a wholly broken identity deployment as a calm signed-out landing with a clean console, and would have hidden exactly the origin-gate breakage this wave hit in the e2e. Narrowed to the 401; new unit test asserts the 403 passes through.
2. **The e2e's cookie patch was wider than its comment.** It attached the journey's session cookie to *every* fetch, including the doubles standing in for the sibling workers — something a browser would never do. Scoped to the Worker origin; the tool-loop section now restores the pristine `fetch`.

Both re-verified: `bun test src` 187/187, typecheck clean, `bun scripts/worker-e2e.ts` PASS, `bun scripts/live-check.ts local` PASS, redeploy + `live` 8/8 + `bun scripts/canary-seam-probe.ts` PASS.

## Honest gaps

- The start-route honest page is not reproducible live while OAuth stays configured upstream; its live proof is the callback route's real failure plus the stub/unit coverage of the identical code path.
- `requestedScopes` upstream is now `read:user` only (the concurrent session's OAuth app), so the landing's scope copy lists just the profile scope — accurate to the upstream, noted so it isn't mistaken for a regression.
- The stashed foreign billing-upstream change remains unapplied; if its 522 claim is real it deserves its own wave with a live proof.
